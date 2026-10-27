import type { Bot } from "grammy";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import type { Agent } from "../core/agent.ts";
import type { Access } from "../core/access.ts";
import type { JobQueue } from "../core/jobs.ts";
import type { Notifier } from "../core/notify.ts";
import type { ChatLog, InFlight, Settings, UpdateGuard, Usage } from "../core/state.ts";
import type { SttProvider } from "../stt/index.ts";
import { errMessage, log } from "../log.ts";
import { recordPost, upsertChat } from "../modules/feeds/repo.ts";
import { setupGroups } from "./groups.ts";
import type { RateProvider } from "../modules/finance/rates.ts";
import { setupSettings } from "./settings.ts";

export { createNotifier } from "./ui.ts";

type Deps = {
  config: Config;
  db: Db;
  agent: Agent;
  stt: SttProvider | null;
  jobs: JobQueue;
  access: Access;
  settings: Settings;
  chatLog: ChatLog;
  usage: Usage;
  notifier: Notifier;
  safety: { discussionOpen: boolean };
  updates: UpdateGuard;
  inFlight: InFlight;
  rates: RateProvider;
};

// Uch joy, uch vazifa:
//   DM            — faqat sozlamalar va statistika
//   Ishchi guruh  — to'liq agent (ruxsatga qarab)
//   Boshqa guruhlar (kanal muhokamalari) — chaqirilganda suhbat, tool'larsiz
export function setupBot(bot: Bot, deps: Deps) {
  const { db, access } = deps;

  // Birinchi qatlam: har bir update bir marta ishlanadi va o'chish paytida oxiriga yetkaziladi.
  bot.use((ctx, next) => {
    if (!deps.updates.claim(ctx.update.update_id)) {
      log.warn("duplicate update skipped", { update: ctx.update.update_id });
      return;
    }
    return deps.inFlight.track(next);
  });

  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) access.touchUser(ctx.from);
    return next();
  });

  // Bot kanal yoki guruhga qo'shildi/olib tashlandi.
  bot.on("my_chat_member", async (ctx) => {
    const chat = ctx.myChatMember.chat;
    const status = ctx.myChatMember.new_chat_member.status;
    let linked: number | null = null;
    if (chat.type === "channel" && status === "administrator") {
      linked = (await ctx.api.getChat(chat.id).catch(() => null))?.linked_chat_id ?? null;
    }
    upsertChat(db, {
      id: chat.id,
      type: chat.type,
      title: ("title" in chat ? chat.title : null) ?? null,
      username: "username" in chat ? (chat.username ?? null) : null,
      linked_chat_id: linked,
      bot_status: status,
    });
    if (status === "administrator" || status === "member") {
      const what = chat.type === "channel" ? "📢 Kanal" : "👥 Guruh";
      const title = "title" in chat ? chat.title : chat.id;
      await deps.notifier.send(access.ownerId, `${what} qo'shildi: ${title}\nSozlamalar: /settings`).catch(() => {});
    }
  });

  // Kanalga qo'lda yozilgan postlar ham saqlanadi — muhokamada kontekst bo'ladi.
  bot.on("channel_post", (ctx) => {
    const text = ctx.channelPost.text ?? ctx.channelPost.caption;
    if (text) recordPost(db, { feedId: null, channelId: ctx.chat.id, messageId: ctx.channelPost.message_id, text });
  });

  setupSettings(bot.filter((ctx) => ctx.chat?.type === "private"), deps);
  setupGroups(bot.filter((ctx) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"), deps);

  bot.catch(async (err) => {
    const msg = errMessage(err.error);
    // Eskirgan tugma bosilishi (foydalanuvchiga zarari yo'q) — chatga xato yozmaymiz.
    if (msg.includes("query is too old") || msg.includes("query ID is invalid")) {
      log.warn("stale callback query", { update: err.ctx.update.update_id });
      return;
    }
    log.error("bot error", { error: msg, update: err.ctx.update.update_id });
    if (err.ctx.chat?.type !== "channel" && !err.ctx.callbackQuery) {
      await err.ctx.reply("⚠️ Xatolik yuz berdi. Qaytadan urinib ko'ring.").catch(() => {});
    }
  });
}
