import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

// Har bir element — bitta migratsiya. Faqat oxiriga qo'shing, eskisini o'zgartirmang.
const migrations: string[] = [
  `
  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    amount REAL NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL,
    category TEXT NOT NULL,
    note TEXT,
    occurred_on TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'text',
    raw_text TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX idx_tx_user_date ON transactions (user_id, occurred_on);

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    run_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_jobs_pick ON jobs (status, run_at);

  CREATE TABLE suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    problem TEXT NOT NULL,
    proposal TEXT NOT NULL,
    effort TEXT NOT NULL,
    area TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed', 'liked', 'disliked', 'queued', 'running', 'pr_opened', 'failed')),
    branch TEXT,
    pr_url TEXT,
    report TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );

  CREATE TABLE permissions (
    user_id INTEGER NOT NULL,
    perm TEXT NOT NULL,
    granted_by INTEGER,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, perm)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Bot qo'shilgan kanal va guruhlar (my_chat_member orqali yoziladi)
  CREATE TABLE chats (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT,
    username TEXT,
    linked_chat_id INTEGER,
    bot_status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    topic TEXT NOT NULL,
    hour INTEGER NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_on TEXT,
    created_at TEXT NOT NULL
  );

  -- Kanal postlari: muhokamada bot post matnini kontekst sifatida oladi
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id INTEGER,
    channel_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    discussion_chat_id INTEGER,
    discussion_message_id INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (channel_id, message_id)
  );
  CREATE INDEX idx_posts_discussion ON posts (discussion_chat_id, discussion_message_id);

  -- Guruhlardagi suhbat tarixi (faqat matn), kontekst uchun
  CREATE TABLE chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    thread_id INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_chat_log ON chat_log (chat_id, thread_id, id);

  CREATE TABLE usage (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    scope TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, scope)
  );
  `,
  `
  -- Telegram update'lari: restart/crash'dan keyin qayta kelsa, ikkinchi marta ishlanmaydi
  CREATE TABLE processed_updates (
    update_id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Oylik majburiy to'lovlar va muntazam daromadlar (ijara, internet, maosh...)
  CREATE TABLE recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    name TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL,
    category TEXT NOT NULL,
    day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_recurring_user ON recurring (user_id, active);

  -- Qaysi oy uchun to'langan/o'tkazilgan (month = YYYY-MM)
  CREATE TABLE recurring_payments (
    recurring_id INTEGER NOT NULL,
    month TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('paid', 'skipped')),
    transaction_id INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (recurring_id, month)
  );
  `,
  `
  -- Bloklangan foydalanuvchi: bot unga hech qayerda javob bermaydi
  ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Yozuv kunidagi kurs: 1 birlik valyuta necha so'm (UZS uchun 1). NULL — hali olinmagan.
  ALTER TABLE transactions ADD COLUMN rate_uzs REAL;
  UPDATE transactions SET rate_uzs = 1 WHERE currency = 'UZS';
  -- CBU kurslari keshi, kun bo'yicha
  CREATE TABLE fx_daily (day TEXT PRIMARY KEY, rates TEXT NOT NULL, fetched_at TEXT NOT NULL);
  `,
  `
  -- Uzoq muddatli xotira: foydalanuvchi haqidagi muhim faktlar va afzalliklar
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_memories_user ON memories (user_id, id);
  `,
  `
  -- Feed manbalari: Telegram kanallar (vergul bilan), vakansiya feedlari uchun
  ALTER TABLE feeds ADD COLUMN sources TEXT NOT NULL DEFAULT '';
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < migrations.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
