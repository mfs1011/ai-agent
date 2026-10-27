import type { Db } from "../../db.ts";
import { nowIso } from "../../db.ts";

export type ChatRow = {
  id: number;
  type: string;
  title: string | null;
  username: string | null;
  linked_chat_id: number | null;
  bot_status: string;
};

export function upsertChat(db: Db, c: Omit<ChatRow, "linked_chat_id"> & { linked_chat_id?: number | null }) {
  db.prepare(
    `INSERT INTO chats (id, type, title, username, linked_chat_id, bot_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title, username = excluded.username,
       linked_chat_id = COALESCE(excluded.linked_chat_id, chats.linked_chat_id), bot_status = excluded.bot_status,
       updated_at = excluded.updated_at`,
  ).run(c.id, c.type, c.title, c.username, c.linked_chat_id ?? null, c.bot_status, nowIso());
}

export function getChat(db: Db, id: number): ChatRow | null {
  return (db.prepare("SELECT id, type, title, username, linked_chat_id, bot_status FROM chats WHERE id = ?").get(id) as ChatRow | undefined) ?? null;
}

/** Bot admin bo'lgan kanallar (post qila oladi). */
export function listChannels(db: Db): ChatRow[] {
  return db
    .prepare("SELECT id, type, title, username, linked_chat_id, bot_status FROM chats WHERE type = 'channel' AND bot_status = 'administrator' ORDER BY title")
    .all() as ChatRow[];
}

export type Feed = {
  id: number;
  channel_id: number;
  topic: string;
  hour: number;
  enabled: number;
  last_run_on: string | null;
  /** Telegram kanallar, vergul bilan (vakansiya feedlari uchun) */
  sources?: string;
};

const FEED_COLS = "id, channel_id, topic, hour, enabled, last_run_on, sources";

export function addFeed(db: Db, channelId: number, topic: string, hour = 9): Feed {
  return db
    .prepare(`INSERT INTO feeds (channel_id, topic, hour, created_at) VALUES (?, ?, ?, ?) RETURNING ${FEED_COLS}`)
    .get(channelId, topic, hour, nowIso()) as Feed;
}

export function getFeed(db: Db, id: number): Feed | null {
  return (db.prepare(`SELECT ${FEED_COLS} FROM feeds WHERE id = ?`).get(id) as Feed | undefined) ?? null;
}

export function listFeeds(db: Db, channelId?: number): Feed[] {
  return (
    channelId === undefined
      ? db.prepare(`SELECT ${FEED_COLS} FROM feeds ORDER BY id`).all()
      : db.prepare(`SELECT ${FEED_COLS} FROM feeds WHERE channel_id = ? ORDER BY id`).all(channelId)
  ) as Feed[];
}

export function updateFeed(db: Db, id: number, patch: Partial<Pick<Feed, "topic" | "hour" | "enabled" | "last_run_on" | "sources">>) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  db.prepare(`UPDATE feeds SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...entries.map(([, v]) => v as string | number | null),
    id,
  );
}

export function deleteFeed(db: Db, id: number) {
  db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
}

/** Shu soatda ishlashi kerak va bugun hali ishlamagan feedlar. */
export function dueFeeds(db: Db, hour: number, today: string): Feed[] {
  return db
    .prepare(`SELECT ${FEED_COLS} FROM feeds WHERE enabled = 1 AND hour = ? AND (last_run_on IS NULL OR last_run_on < ?)`)
    .all(hour, today) as Feed[];
}

export function recordPost(db: Db, p: { feedId: number | null; channelId: number; messageId: number; text: string }) {
  db.prepare(
    `INSERT INTO posts (feed_id, channel_id, message_id, text, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, message_id) DO UPDATE SET text = excluded.text`,
  ).run(p.feedId, p.channelId, p.messageId, p.text, nowIso());
}

/** Kanal posti muhokama guruhiga avtomatik forward bo'lganda bog'lab qo'yiladi. */
export function linkDiscussion(db: Db, channelId: number, messageId: number, discussionChatId: number, discussionMessageId: number, text: string) {
  db.prepare(
    `INSERT INTO posts (feed_id, channel_id, message_id, text, discussion_chat_id, discussion_message_id, created_at)
     VALUES (NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, message_id) DO UPDATE SET discussion_chat_id = excluded.discussion_chat_id,
       discussion_message_id = excluded.discussion_message_id`,
  ).run(channelId, messageId, text, discussionChatId, discussionMessageId, nowIso());
}

export function postByDiscussion(db: Db, discussionChatId: number, discussionMessageId: number): string | null {
  const row = db
    .prepare("SELECT text FROM posts WHERE discussion_chat_id = ? AND discussion_message_id = ?")
    .get(discussionChatId, discussionMessageId) as { text: string } | undefined;
  return row?.text ?? null;
}

export function recentPostTexts(db: Db, feedId: number, limit = 15): string[] {
  return (db.prepare("SELECT text FROM posts WHERE feed_id = ? ORDER BY id DESC LIMIT ?").all(feedId, limit) as { text: string }[]).map(
    (r) => r.text,
  );
}
