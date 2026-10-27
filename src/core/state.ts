import type { Db } from "../db.ts";
import { nowIso } from "../db.ts";
import type { ChatTurn } from "./agent.ts";

// Kichik holatlar: sozlamalar, suhbat tarixi, kunlik limitlar.

export const SETTING_DEFAULTS = {
  work_chat_id: "",
  /** Erkin suhbat guruhi (har bir xabarga javob, umumiy yordamchi). */
  chat_chat_id: "",
  public_daily_limit: "20",
  /** Oxirgi xavfsizlik tekshiruvi natijasi: "" | "isolated" | "leaky". */
  agy_isolation: "",
  /** "0" — bot muhokama guruhlarida umuman javob bermaydi. */
  discussion_enabled: "1",
  /** Valyuta kurslari keshi (CBU), JSON. */
  fx_rates: "",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export class Settings {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(key: SettingKey): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? SETTING_DEFAULTS[key];
  }

  set(key: SettingKey, value: string) {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  chatChatId(): number | null {
    const v = this.get("chat_chat_id");
    return v ? Number(v) : null;
  }

  workChatId(): number | null {
    const v = this.get("work_chat_id");
    return v ? Number(v) : null;
  }

  publicDailyLimit(): number {
    return Number(this.get("public_daily_limit")) || 0;
  }
}

export class ChatLog {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  append(chatId: number, threadId: number, userId: number | null, role: "user" | "assistant", text: string) {
    this.db
      .prepare("INSERT INTO chat_log (chat_id, thread_id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chatId, threadId, userId, role, text, nowIso());
  }

  /**
   * Oxirgi xabarlar: user'dan boshlanadi, rollar navbatma-navbat
   * (ketma-ket bir xil roldagi xabarlar birlashtiriladi).
   */
  history(chatId: number, threadId: number, limit = 12): ChatTurn[] {
    const rows = (
      this.db
        .prepare("SELECT role, text FROM chat_log WHERE chat_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?")
        .all(chatId, threadId, limit) as { role: "user" | "assistant"; text: string }[]
    ).reverse();
    const out: { role: "user" | "assistant"; content: string }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.role === r.role) last.content += `\n\n${r.text}`;
      else out.push({ role: r.role, content: r.text });
    }
    while (out[0]?.role === "assistant") out.shift();
    // Yangi user xabari ortidan qo'shiladi, shuning uchun tarix assistant bilan tugashi kerak.
    if (out[out.length - 1]?.role === "user") out.pop();
    return out;
  }
}

export class Usage {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  count(userId: number, day: string, scope: string): number {
    const row = this.db.prepare("SELECT count FROM usage WHERE user_id = ? AND day = ? AND scope = ?").get(userId, day, scope) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  increment(userId: number, day: string, scope: string) {
    this.db
      .prepare(
        `INSERT INTO usage (user_id, day, scope, count) VALUES (?, ?, ?, 1)
         ON CONFLICT (user_id, day, scope) DO UPDATE SET count = count + 1`,
      )
      .run(userId, day, scope);
  }

  totalForDay(day: string, scope: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM usage WHERE day = ? AND scope = ?").get(day, scope) as { n: number }).n;
  }
}

/**
 * Har bir Telegram update faqat bir marta ishlanadi.
 * Restart yoki crash paytida Telegram tugallanmagan update'ni qayta yuboradi — ikkinchi marta javob yoki
 * ikkinchi marta yozuv (masalan, xarajat) bo'lmasligi uchun.
 */
export class UpdateGuard {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** true — birinchi marta, ishlash kerak. false — allaqachon ko'rilgan. */
  claim(updateId: number): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?, ?)")
      .run(updateId, nowIso());
    return res.changes > 0;
  }

  /** Eski yozuvlarni tozalash (Telegram update'larni 24 soatdan ortiq saqlamaydi). */
  prune(olderThanMs = 3 * 86_400_000) {
    this.db.prepare("DELETE FROM processed_updates WHERE created_at < ?").run(new Date(Date.now() - olderThanMs).toISOString());
  }
}

/** Hozir ishlanayotgan update'lar soni — o'chishdan oldin ularni tugatib olish uchun. */
export class InFlight {
  private count = 0;
  private waiters: (() => void)[] = [];

  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.count++;
    try {
      return await fn();
    } finally {
      this.count--;
      if (this.count === 0) for (const w of this.waiters.splice(0)) w();
    }
  }

  get size() {
    return this.count;
  }

  /** Hammasi tugashini kutadi, lekin `timeoutMs`dan ko'p emas. true — hammasi tugadi. */
  idle(timeoutMs: number): Promise<boolean> {
    if (this.count === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
