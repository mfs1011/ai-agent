import { InputFile } from "grammy";
import type { Composer, Context } from "grammy";
import type { Message } from "grammy/types";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import type { Agent, AgentReply } from "../core/agent.ts";
import type { Access } from "../core/access.ts";
import { displayName } from "../core/access.ts";
import type { JobQueue } from "../core/jobs.ts";
import { clip } from "../core/notify.ts";
import type { ChatLog, Settings, Usage } from "../core/state.ts";
import { localDate } from "../core/time.ts";
import type { SttProvider } from "../stt/index.ts";
import { sttVocabulary } from "../stt/index.ts";
import { errMessage, log } from "../log.ts";
import { isAborted } from "../core/exec.ts";
import { deleteTransaction, formatAmount, getTransaction, knownTerms, setTransactionRate } from "../modules/finance/repo.ts";
import { getChat, linkDiscussion, postByDiscussion } from "../modules/feeds/repo.ts";
import { JOB_GENERATE, startImplement } from "../modules/ideas/index.ts";
import { formatSuggestion, likedButtons } from "../modules/ideas/generate.ts";
import { getSuggestion, listSuggestions, transition } from "../modules/ideas/repo.ts";
import { LiveMessage, keyboard, rich } from "./ui.ts";
import { memoryContext } from "../modules/memory/index.ts";
import { Corrections } from "./corrections.ts";
import type { VoiceTurn } from "./corrections.ts";
import { buildMonthReport, renderPng, reportCaption, reportSvg } from "../modules/finance/report-image.ts";
import type { RateProvider } from "../modules/finance/rates.ts";
import { forecastMonth, getRecurring, markPaid, markSkipped } from "../modules/finance/recurring.ts";
import { formatForecast } from "../modules/finance/jobs.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Deps = {
  db: Db;
  config: Config;
  agent: Agent;
  stt: SttProvider | null;
  jobs: JobQueue;
  access: Access;
  settings: Settings;
  chatLog: ChatLog;
  usage: Usage;
  safety: { discussionOpen: boolean };
  rates: RateProvider;
};

const MAX_DISCUSSION_INPUT = 1500;

export const WORK_HELP = `💬 Ishchi guruh. Oddiy matn yoki ovoz yozing:

• «taksiga 25 ming berdim» — xarajat
• «maosh tushdi 8 million» — daromad
• «shu oy qancha sarfladim?» — hisobot
• «yangi takliflar ber» — loyiha takliflari

/report — oy hisoboti · /ideas — takliflar · /liked — yoqqan takliflar`;

export const CHAT_HELP = `💬 Erkin suhbat. Istalgan narsani yozing yoki ovozli xabar yuboring — savol, maslahat, tushuntirish, kod, tarjima, yangiliklar…`;

/** Muhokama ipi (thread) ildizi: kanal postining guruhdagi nusxasi. */
function threadRoot(msg: Message): number {
  if (msg.message_thread_id) return msg.message_thread_id;
  if (msg.reply_to_message?.is_automatic_forward) return msg.reply_to_message.message_id;
  return 0;
}

export function setupGroups(group: Composer<Context>, deps: Deps) {
  const { db, config, agent, stt, jobs, access, settings, chatLog, usage } = deps;
  const isWork = (ctx: Context) => ctx.chat?.id === settings.workChatId();
  const isChat = (ctx: Context) => ctx.chat?.id === settings.chatChatId();

  /**
   * Xabar muallifi. Anonim admin ("Send Anonymously", guruh nomidan) yoki botimiz admin bo'lgan kanal nomidan
   * yozilgan xabarda Telegram haqiqiy userni bermaydi — bunday holatda bu egasi deb hisoblanadi.
   * Begona kanal nomidan yozilgan xabar esa ruxsatsiz oddiy foydalanuvchi.
   */
  const actor = (ctx: Context): { id: number; name: string } | null => {
    const sc = ctx.message?.sender_chat;
    if (sc) {
      const trusted = sc.id === ctx.chat?.id || getChat(db, sc.id)?.bot_status === "administrator";
      if (!trusted) return { id: sc.id, name: ("title" in sc ? sc.title : undefined) ?? "Kanal" };
      return { id: access.ownerId, name: displayName(access.getUser(access.ownerId), access.ownerId) };
    }
    return ctx.from && !ctx.from.is_bot ? { id: ctx.from.id, name: displayName(ctx.from) } : null;
  };
  /** Muhokama: egasi o'chirmagan va xavfsizlik tekshiruvi o'tgan bo'lsa — hamma uchun ochiq. */
  const discussionEnabled = () => settings.get("discussion_enabled") !== "0";

  // ---------- Sozlash ----------

  group.command("setup_work", async (ctx) => {
    const a = actor(ctx);
    if (!a || !access.isOwner(a.id)) return;
    if (ctx.chat.id === settings.chatChatId()) settings.set("chat_chat_id", "");
    settings.set("work_chat_id", String(ctx.chat.id));
    await ctx.reply(`✅ Bu guruh ishchi guruh qilib belgilandi.\n\n${WORK_HELP}`);
  });

  group.command("setup_chat", async (ctx) => {
    const a = actor(ctx);
    if (!a || !access.isOwner(a.id)) return;
    if (ctx.chat.id === settings.workChatId()) settings.set("work_chat_id", "");
    settings.set("chat_chat_id", String(ctx.chat.id));
    await ctx.reply(`✅ Bu guruh erkin suhbat guruhi qilib belgilandi.\n\n${CHAT_HELP}`);
  });

  // Oddiy guruh supergroup'ga aylansa (masalan Topics yoqilganda) ID o'zgaradi — yangi ID'ga ko'chiramiz.
  group.on("message:migrate_to_chat_id", (ctx) => {
    const to = String(ctx.message.migrate_to_chat_id);
    if (ctx.chat.id === settings.workChatId()) settings.set("work_chat_id", to);
    if (ctx.chat.id === settings.chatChatId()) settings.set("chat_chat_id", to);
  });

  // Kanal posti muhokama guruhiga tushdi — post matnini ip bilan bog'laymiz.
  group.on("message:is_automatic_forward", (ctx, next) => {
    const origin = ctx.message.forward_origin;
    if (origin?.type === "channel") {
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      linkDiscussion(db, origin.chat.id, origin.message_id, ctx.chat.id, ctx.message.message_id, text);
      return;
    }
    return next();
  });

  // ---------- Ishchi va suhbat guruhlari ----------

  const corrections = new Corrections();

  // "⏹ To'xtatish": har bir ishlanayotgan xabar uchun AbortController (kalit — foydalanuvchi xabari).
  const running = new Map<string, { ctrl: AbortController; userId: number }>();
  const runKey = (chatId: number, msgId: number) => `${chatId}:${msgId}`;
  const stopButtons = (msgId: number) => [[{ text: "⏹ To'xtatish", data: `stop:${msgId}`, style: "danger" as const }]];
  /** Xabar uchun bekor qilish signali (ovozda transcribe va javob bitta signalni ishlatadi). */
  const controllerFor = (ctx: Context): AbortController => {
    const key = runKey(ctx.chat!.id, ctx.message!.message_id);
    const existing = running.get(key);
    if (existing) return existing.ctrl;
    const ctrl = new AbortController();
    running.set(key, { ctrl, userId: actor(ctx)!.id });
    return ctrl;
  };
  const release = (ctx: Context) => running.delete(runKey(ctx.chat!.id, ctx.message!.message_id));
  const replyParams = (ctx: Context) => ({
    reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
  });

  const workAnswer = async (
    ctx: Context,
    text: string,
    source: "text" | "voice",
    mode: "work" | "chat" = "work",
  ): Promise<AgentReply | null> => {
    const msg = ctx.message!;
    const { id: userId, name: userName } = actor(ctx)!;
    const thread = msg.message_thread_id ?? 0;
    usage.increment(userId, localDate(new Date(), config.TZ_OFFSET_MINUTES), "work");
    const ctrl = controllerFor(ctx);
    const live = new LiveMessage(ctx.api, ctx.chat!.id, {
      replyTo: msg.message_id,
      controls: stopButtons(msg.message_id),
      rich: true,
    });
    live.startThinking("💭 O'ylayapman");
    try {
      const reply = await agent.handle(
        text,
        {
          userId,
          userName,
          chatId: ctx.chat!.id,
          source,
          mode,
          perms: access.perms(userId),
          history: chatLog.history(ctx.chat!.id, thread),
          memory: memoryContext(db, userId),
        },
        (partial) => live.update(partial),
        ctrl.signal,
      );
      chatLog.append(ctx.chat!.id, thread, userId, "user", `${userName}: ${text}`);
      chatLog.append(ctx.chat!.id, thread, null, "assistant", reply.text);
      await live.finish(reply.text, reply.buttons);
      for (const p of reply.photos) {
        await ctx.replyWithPhoto(new InputFile(p.png, "rasm.png"), { caption: p.caption, parse_mode: "HTML", ...replyParams(ctx) });
      }
      return reply;
    } catch (e) {
      if (isAborted(e)) {
        await live.finish("⏹ To'xtatildi.");
        return null;
      }
      log.error("work answer failed", { error: errMessage(e) });
      await live.finish("⚠️ Xatolik yuz berdi. Qaytadan urinib ko'ring.");
      return null;
    } finally {
      release(ctx);
    }
  };

  const fixButtons = (voiceMsgId: number) => [[{ text: "✏️ Tuzatish", data: `vf:${voiceMsgId}`, style: "primary" as const }]];

  const transcribe = async (ctx: Context): Promise<{ text: string; transcriptMsgId: number | null } | null> => {
    const msg = ctx.message!;
    const media = msg.voice ?? msg.audio;
    if (!media) return null;
    if (!stt) {
      await ctx.reply("Ovozni tanish sozlanmagan (STT_PROVIDER).");
      return null;
    }
    // agy bilan ~10 soniya: darhol belgi beramiz, eshitilgan matn jonli to'lib boradi.
    const ctrl = controllerFor(ctx);
    const live = new LiveMessage(ctx.api, ctx.chat!.id, { replyTo: msg.message_id, controls: stopButtons(msg.message_id) });
    live.startThinking("🎙 Tinglayapman");
    try {
      const file = await ctx.getFile();
      const res = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`);
      if (!res.ok) throw new Error(`Faylni yuklab bo'lmadi: ${res.status}`);
      const text = await stt.transcribe(Buffer.from(await res.arrayBuffer()), {
        filename: file.file_path?.split("/").pop() ?? "voice.ogg",
        mimeType: media.mime_type ?? "audio/ogg",
        vocabulary: sttVocabulary(config, knownTerms(db, actor(ctx)!.id)),
        onPartial: (p) => p && live.update(`🎙 Eshitdim: «${p}`),
        signal: ctrl.signal,
      });
      if (!text) {
        await live.finish("🎙 Ovozdan hech narsa tushunmadim, qaytadan ayting.");
        return null;
      }
      await live.finish(`🎙 Eshitdim: «${text}»`, fixButtons(msg.message_id));
      return { text, transcriptMsgId: live.id };
    } catch (e) {
      if (isAborted(e) || ctrl.signal.aborted) {
        await live.finish("⏹ To'xtatildi.");
        release(ctx);
        return null;
      }
      log.error("transcribe failed", { error: errMessage(e) });
      await live.finish("🎙 Ovozni tanib bo'lmadi, qaytadan yuboring yoki matn bilan yozing.");
      return null;
    }
  };

  /** Ovoz noto'g'ri eshitilgan: oldingi natijani bekor qilib, to'g'ri matn bilan qayta bajaramiz. */
  const applyCorrection = async (ctx: Context, turn: VoiceTurn, newText: string, source: "text" | "voice", mode: "work" | "chat") => {
    const reverted = corrections.revert(turn);
    if (turn.transcriptMsgId) {
      await ctx.api
        .editMessageText(
          turn.chatId,
          turn.transcriptMsgId,
          `🎙 Eshitdim: <s>${esc(turn.transcript)}</s>\n✏️ Tuzatildi: «${esc(newText)}»` +
            (reverted ? `\n↩️ Oldingi natija bekor qilindi (${reverted} ta)` : ""),
          { parse_mode: "HTML", reply_markup: keyboard(fixButtons(turn.voiceMsgId)) },
        )
        .catch(() => {});
    }
    const reply = await workAnswer(ctx, newText, source, mode);
    corrections.remember({ ...turn, transcript: newText, undo: reply?.undo ?? [] });
  };

  const onText = async (ctx: Context, mode: "work" | "chat") => {
    const msg = ctx.message!;
    const text = msg.text!;
    if (text.startsWith("/")) return;
    const userId = actor(ctx)!.id;
    // Tuzatish: "✏️ Tuzatish" bosilgandan keyingi xabar yoki "Eshitdim" xabariga reply.
    const replied = msg.reply_to_message ? corrections.byTranscriptMsg(ctx.chat!.id, msg.reply_to_message.message_id) : null;
    const turn = corrections.takePending(ctx.chat!.id, userId) ?? (replied?.userId === userId ? replied : null);
    if (turn) return applyCorrection(ctx, turn, text, "text", mode);
    await workAnswer(ctx, text, "text", mode);
  };

  const onVoice = async (ctx: Context, mode: "work" | "chat") => {
    const userId = actor(ctx)!.id;
    const pendingTurn = corrections.takePending(ctx.chat!.id, userId);
    const heard = await transcribe(ctx);
    if (!heard) return void release(ctx);
    if (pendingTurn) return applyCorrection(ctx, pendingTurn, heard.text, "voice", mode);
    const reply = await workAnswer(ctx, heard.text, "voice", mode);
    corrections.remember({
      chatId: ctx.chat!.id,
      userId,
      voiceMsgId: ctx.message!.message_id,
      transcript: heard.text,
      transcriptMsgId: heard.transcriptMsgId,
      undo: reply?.undo ?? [],
    });
  };

  group.callbackQuery(/^vf:(\d+)$/, async (ctx) => {
    const turn = corrections.get(ctx.chat!.id, Number(ctx.match[1]));
    if (!turn) return void (await ctx.answerCallbackQuery("Bu xabarni endi tuzatib bo'lmaydi — qaytadan yuboring"));
    const presser = ctx.from.id;
    if (presser !== turn.userId && !(access.isOwner(presser) && turn.userId === access.ownerId)) {
      return void (await ctx.answerCallbackQuery("Faqat o'z xabaringizni tuzata olasiz"));
    }
    corrections.startEdit(turn);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "✏️ To'g'ri variantni yozing yoki ovoz bilan qaytadan ayting.\nOldingi natija bekor qilinib, qaytadan bajariladi.\n\n" +
        "Eshitilgan matnni nusxalab, tuzatib yuborishingiz mumkin:",
      {
        reply_markup: keyboard([
          [{ text: "📋 Matnni nusxalash", copy: turn.transcript }],
          [{ text: "✖️ Bekor qilish", data: "vfx" }],
        ]),
        reply_parameters: turn.transcriptMsgId ? { message_id: turn.transcriptMsgId, allow_sending_without_reply: true } : undefined,
      },
    );
  });

  group.callbackQuery(/^stop:(\d+)$/, async (ctx) => {
    const entry = running.get(runKey(ctx.chat!.id, Number(ctx.match[1])));
    if (!entry) return void (await ctx.answerCallbackQuery("Allaqachon tugagan"));
    const presser = ctx.from.id;
    if (presser !== entry.userId && !access.isOwner(presser)) {
      return void (await ctx.answerCallbackQuery("Faqat so'rov egasi to'xtata oladi"));
    }
    entry.ctrl.abort();
    await ctx.answerCallbackQuery("⏹ To'xtatilmoqda…");
  });

  // Majburiy to'lov: "✅ To'landi" — xarajat yoziladi; "⏭ Bu oy yo'q" — shu oy uchun o'tkaziladi.
  group.callbackQuery(/^rc:(paid|skip):(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    const [, action, idStr, month] = ctx.match;
    const presser = ctx.from.id;
    const row = db.prepare("SELECT user_id FROM recurring WHERE id = ?").get(Number(idStr)) as { user_id: number } | undefined;
    if (!row) return void (await ctx.answerCallbackQuery("Topilmadi"));
    if (row.user_id !== presser && !access.isOwner(presser)) return void (await ctx.answerCallbackQuery("Bu sizning to'lovingiz emas"));
    const r = getRecurring(db, row.user_id, Number(idStr))!;
    if (action === "paid") {
      const today = localDate(new Date(), config.TZ_OFFSET_MINUTES);
      const res = markPaid(db, row.user_id, r.id, month!, today.startsWith(month!) ? today : `${month}-01`);
      await ctx.answerCallbackQuery(res.ok ? "✅ Yozildi" : "Allaqachon belgilangan");
      if (res.ok && r.currency !== "UZS") {
        const tx = getTransaction(db, row.user_id, res.transactionId!);
        const rate = tx ? (await deps.rates.forDate(tx.occurred_on))?.[tx.currency] : undefined;
        if (rate) setTransactionRate(db, res.transactionId!, rate);
      }
      if (res.ok) {
        const text = `✅ **${r.name}** — ${formatAmount(r.amount, r.currency)} ${r.kind === "income" ? "tushdi" : "to'landi"} va yozildi`;
        await ctx.editMessageText(rich(text).text, {
          parse_mode: "HTML",
          reply_markup: keyboard([[{ text: `↩️ #${res.transactionId} bekor qilish`, data: `tx:undo:${res.transactionId}`, style: "danger" }]]),
        }).catch(() => {});
      }
    } else {
      const ok = markSkipped(db, row.user_id, r.id, month!);
      await ctx.answerCallbackQuery(ok ? "⏭ Bu oy o'tkazildi" : "Allaqachon belgilangan");
      if (ok) await ctx.editMessageText(rich(`⏭ **${r.name}** — bu oy o'tkazildi`).text, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  group.callbackQuery("vfx", async (ctx) => {
    corrections.cancelEdit(ctx.chat!.id, ctx.from.id);
    if (access.isOwner(ctx.from.id)) corrections.cancelEdit(ctx.chat!.id, access.ownerId);
    await ctx.answerCallbackQuery("Bekor qilindi");
    await ctx.deleteMessage().catch(() => {});
  });

  const work = group.filter(isWork);
  // Ishchi guruhda faqat "agent" ruxsati borlar bilan ishlaymiz; boshqalarning xabarlari e'tiborsiz.
  const workMember = work.filter((ctx) => {
    const a = actor(ctx);
    return !!a && !access.isBlocked(a.id) && access.has(a.id, "agent");
  });

  workMember.command("help", (ctx) => ctx.reply(WORK_HELP));
  // Hisobot — LLM'siz, darhol: rasm + qisqa matn.
  workMember.command("report", async (ctx) => {
    const userId = actor(ctx)!.id;
    if (!access.has(userId, "finance")) return void (await ctx.reply("Moliya bo'limiga ruxsatingiz yo'q."));
    await ctx.replyWithChatAction("upload_photo");
    const m = buildMonthReport(db, userId, new Date(), config.TZ_OFFSET_MINUTES, config.DEFAULT_CURRENCY, await deps.rates.get());
    await ctx.replyWithPhoto(new InputFile(renderPng(reportSvg(m)), "hisobot.png"), {
      caption: reportCaption(m),
      parse_mode: "HTML",
      ...replyParams(ctx),
    });
  });
  workMember.command(["majburiy", "prognoz"], async (ctx) => {
    const userId = actor(ctx)!.id;
    if (!access.has(userId, "finance")) return void (await ctx.reply("Moliya bo'limiga ruxsatingiz yo'q."));
    const f = forecastMonth(db, userId, new Date(), config.TZ_OFFSET_MINUTES, config.DEFAULT_CURRENCY, await deps.rates.get());
    const due = f.items.filter((i) => i.status === "due").slice(0, 6);
    const buttons = due.map((i) => [
      { text: `${i.kind === "income" ? "✅ Tushdi" : "✅ To'landi"}: ${i.name}`, data: `rc:paid:${i.id}:${f.month}`, style: "success" as const },
    ]);
    const view = rich(formatForecast(f));
    await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: keyboard(buttons), ...replyParams(ctx) });
  });
  workMember.command("ideas", async (ctx) => {
    if (!access.has(actor(ctx)!.id, "ideas")) return void (await ctx.reply("Takliflarga ruxsatingiz yo'q."));
    jobs.enqueue(JOB_GENERATE, { chatId: ctx.chat.id });
    await ctx.reply("💡 Takliflar tayyorlanmoqda…");
  });
  workMember.command("liked", async (ctx) => {
    if (!access.has(actor(ctx)!.id, "ideas")) return void (await ctx.reply("Takliflarga ruxsatingiz yo'q."));
    const list = listSuggestions(db, ["liked", "failed"]);
    if (list.length === 0) return void (await ctx.reply("Yoqqan taklif yo'q. /ideas bilan yangisini so'rang."));
    for (const s of list) await ctx.reply(rich(formatSuggestion(s)).text, { parse_mode: "HTML", reply_markup: keyboard(likedButtons(s.id)) });
  });
  workMember.on("message:text", (ctx) => onText(ctx, "work"));
  workMember.on(["message:voice", "message:audio"], (ctx) => onVoice(ctx, "work"));

  // ---------- Erkin suhbat guruhi ----------

  const chatMember = group.filter(isChat).filter((ctx) => {
    const a = actor(ctx);
    return !!a && !access.isBlocked(a.id) && access.has(a.id, "agent");
  });
  chatMember.command("help", (ctx) => ctx.reply(CHAT_HELP));
  chatMember.on("message:text", (ctx) => onText(ctx, "chat"));
  chatMember.on(["message:voice", "message:audio"], (ctx) => onVoice(ctx, "chat"));

  // ---------- Muhokama guruhlari (ishchi va suhbat guruhlaridan boshqa har qanday guruh) ----------

  const discussion = group.filter((ctx) => !isWork(ctx) && !isChat(ctx));

  /** Bot chaqirildimi: @mention, botning xabariga reply yoki /ask. Chaqiruvdan tozalangan matnni qaytaradi. */
  const calledText = (ctx: Context): string | null => {
    const msg = ctx.message;
    const text = msg?.text ?? msg?.caption;
    if (!msg || !text) return null;
    const mention = `@${ctx.me.username}`;
    if (text.startsWith("/ask")) return text.replace(/^\/ask(@\w+)?\s*/, "");
    if (text.toLowerCase().includes(mention.toLowerCase())) return text.replace(new RegExp(mention, "ig"), "").trim();
    if (msg.reply_to_message?.from?.id === ctx.me.id) return text;
    return null;
  };

  discussion.on("message", async (ctx, next) => {
    const asked = calledText(ctx);
    if (asked === null) return next();
    const who = actor(ctx);
    if (!who) return next();
    const userId = who.id;
    const replyTo = { message_id: ctx.message.message_id, allow_sending_without_reply: true };
    // Bloklangan odamga ham, egasi muhokamani o'chirgan bo'lsa ham — jim (javob yo'q).
    // Begonalar, bloklanganlar yoki muhokama o'chirilgan bo'lsa — jim (javob yo'q).
    // Faqat egasi, adminlar va "chat" ruxsati berilganlar bilan suhbat.
    if (access.isBlocked(userId) || !access.has(userId, "chat")) return;
    if (!discussionEnabled() && !access.isOwner(userId)) return;
    if (!asked) return void (await ctx.reply("Savolingizni yozing 🙂", { reply_parameters: replyTo }));

    const today = localDate(new Date(), config.TZ_OFFSET_MINUTES);
    const unlimited = access.has(userId, "unlimited");
    if (!unlimited && usage.count(userId, today, "discussion") >= settings.publicDailyLimit()) {
      return void (await ctx.reply("Bugungi savollar limiti tugadi, ertaga yana yozing.", { reply_parameters: replyTo }));
    }
    if (!unlimited && asked.length > MAX_DISCUSSION_INPUT) {
      return void (await ctx.reply("Xabar juda uzun, qisqaroq yozing.", { reply_parameters: replyTo }));
    }

    const root = threadRoot(ctx.message);
    const post = root ? postByDiscussion(db, ctx.chat.id, root) : null;
    const quoted = ctx.message.reply_to_message;
    const quotedText = quoted && quoted.message_id !== root ? (quoted.text ?? quoted.caption) : undefined;
    const context = [
      post ? `Kanal posti:\n${post.slice(0, 4000)}` : null,
      quotedText ? `Javob berilayotgan xabar (${displayName(quoted?.from ?? null)}):\n${quotedText.slice(0, 1500)}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    usage.increment(userId, today, "discussion");
    const live = new LiveMessage(ctx.api, ctx.chat.id, { replyTo: ctx.message.message_id, rich: true });
    live.startThinking("💭 O'ylayapman");
    try {
      const reply = await agent.handle(
        asked,
        {
          userId,
          userName: who.name,
          chatId: ctx.chat.id,
          source: "text",
          mode: "discussion",
          perms: access.perms(userId),
          history: chatLog.history(ctx.chat.id, root, 8),
          context: context || undefined,
        },
        (partial) => live.update(partial),
      );
      chatLog.append(ctx.chat.id, root, userId, "user", `${who.name}: ${asked}`);
      chatLog.append(ctx.chat.id, root, null, "assistant", reply.text);
      await live.finish(reply.text);
    } catch (e) {
      log.error("discussion answer failed", { error: errMessage(e) });
      await live.finish("⚠️ Hozir javob bera olmadim, keyinroq urinib ko'ring.");
    }
  });

  // ---------- Tugmalar (ishchi guruhdagi xabarlardan) ----------

  group.callbackQuery(/^tx:undo:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const tx = getTransaction(db, ctx.from.id, id);
    const ok = deleteTransaction(db, ctx.from.id, id);
    await ctx.answerCallbackQuery(ok ? "Bekor qilindi" : "Topilmadi yoki sizniki emas");
    if (ok && tx) await ctx.reply(`↩️ #${id} bekor qilindi (${tx.category}).`);
  });

  group.callbackQuery(/^sg:(like|dislike|do):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const need = action === "do" ? "ideas.implement" : "ideas";
    if (!access.has(ctx.from.id, need)) return void (await ctx.answerCallbackQuery("Ruxsatingiz yo'q"));
    if (!getSuggestion(db, id)) return void (await ctx.answerCallbackQuery("Topilmadi"));

    if (action === "like") {
      transition(db, id, ["proposed", "disliked"], "liked");
      await ctx.answerCallbackQuery("👍 Saqlandi");
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard(likedButtons(id)) });
    } else if (action === "dislike") {
      transition(db, id, ["proposed", "liked", "failed"], "disliked");
      await ctx.answerCallbackQuery("👎 Hisobga olindi");
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } else {
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(startImplement({ db, jobs }, id, ctx.chat!.id));
    }
  });
}
