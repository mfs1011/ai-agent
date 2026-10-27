import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { Button } from "../core/agent.ts";
import type { Notifier } from "../core/notify.ts";
import { RICH_LIMIT, clip } from "../core/notify.ts";
import { errMessage, log } from "../log.ts";
import { isParseError, mdToHtml, mdToPlain } from "./format.ts";

/** Markdown'ni HTML qilib yuborish; Telegram rad etsa — oddiy matn. HTML kengayishi uchun xom matn biroz qisqaroq kesiladi. */
const MD_LIMIT = 3500;
export function rich(md: string): { text: string; parse_mode: "HTML" } {
  return { text: mdToHtml(clip(md, MD_LIMIT)), parse_mode: "HTML" };
}
export async function withPlainFallback<T>(md: string, send: (text: string, parseMode?: "HTML") => Promise<T>): Promise<T> {
  try {
    return await send(mdToHtml(clip(md, MD_LIMIT)), "HTML");
  } catch (e) {
    if (!isParseError(e)) throw e;
    return send(clip(mdToPlain(md)));
  }
}

export function keyboard(rows: Button[][]): InlineKeyboard | undefined {
  if (rows.length === 0) return undefined;
  return InlineKeyboard.from(
    rows.map((row) =>
      row.map((b) => {
        const look = { ...(b.style ? { style: b.style } : {}), ...(b.icon ? { icon_custom_emoji_id: b.icon } : {}) };
        if ("url" in b) return { text: b.text, url: b.url, ...look };
        if ("copy" in b) return { text: b.text, copy_text: { text: b.copy.slice(0, 256) }, ...look };
        return { text: b.text, callback_data: b.data, ...look };
      }),
    ),
  );
}

/** Bildirishnomalar Markdown'da yoziladi va Telegram HTML bo'lib chiqadi. */
export function createNotifier(bot: Bot): Notifier {
  return {
    async send(chatId, text, buttons = []) {
      const m = await withPlainFallback(text, (t, parse_mode) =>
        bot.api.sendMessage(chatId, t, { parse_mode, reply_markup: keyboard(buttons) }),
      );
      return m.message_id;
    },
    async edit(chatId, messageId, text, buttons = []) {
      await withPlainFallback(text, (t, parse_mode) =>
        bot.api.editMessageText(chatId, messageId, t, { parse_mode, reply_markup: keyboard(buttons) }),
      );
    },
    async sendRich(chatId, markdown, buttons = []) {
      try {
        const m = await bot.api.sendRichMessage(chatId, { markdown: clip(markdown, RICH_LIMIT) }, { reply_markup: keyboard(buttons) });
        return m.message_id;
      } catch (e) {
        log.warn("rich message rejected, sending as HTML", { chatId, error: errMessage(e) });
        return this.send(chatId, markdown, buttons);
      }
    },
  };
}

/** Telegram bir xil matn bilan edit qilinsa xato beradi — buni e'tiborsiz qoldiramiz. */
export function ignoreNotModified(e: unknown) {
  if (e instanceof Error && e.message.includes("message is not modified")) return;
  throw e;
}

type MessageApi = {
  sendMessage(chatId: number, text: string, other?: object): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string | { markdown: string }, other?: object): Promise<unknown>;
  sendChatAction?(chatId: number, action: "typing", other?: object): Promise<unknown>;
  sendRichMessage?(chatId: number, rich: { markdown: string }, other?: object): Promise<{ message_id: number }>;
};

/** Telegram tavsiya qilgan "AI Actions" premium emoji — o'ylash animatsiyasi uchun (rich xabarda jonli). */
const THINK_EMOJI = "![💭](tg://emoji?id=5535034915403333642)";

type View = { text: string; parse_mode?: "HTML"; rich?: string };

/** Yozish paytida kursor "lipillab" turadi. */
const CURSORS = [" ▍", " ▌"];
const DOTS = [".", "..", "..."];
/** Telegram'ning "typing…" indikatori ~5 s yashaydi — shundan oldin yangilaymiz. */
const TYPING_EVERY_MS = 4500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Telegram guruhda bitta chatga daqiqasiga ~20 ta xabar/tahrir ruxsat beradi, oshsa 429 bilan bloklaydi.
 * Animatsiya kadrlari shu byudjetdan oshmaydi; yakuniy javob esa doim yuboriladi.
 */
export class ChatBudget {
  private used = new Map<number, number[]>();
  private max: number;
  private windowMs: number;

  constructor(max = 18, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Kadr yuborish mumkinmi. force — yakuniy xabar: doim yuboriladi, lekin hisobga olinadi. */
  take(chatId: number, force = false): boolean {
    const now = Date.now();
    const list = (this.used.get(chatId) ?? []).filter((t) => now - t < this.windowMs);
    if (!force && list.length >= this.max) {
      this.used.set(chatId, list);
      return false;
    }
    list.push(now);
    this.used.set(chatId, list);
    return true;
  }
}

const sharedBudget = new ChatBudget();

/**
 * Keyingi ochiladigan joy: qolganining ~uchdan biri (kamida minStep), so'z chegarasida.
 * agy javobni portlab beradi (masalan 46 → 487 → 644 belgi bir soniyada) — shuning uchun matn kelishi bilan emas,
 * bir maromda, "yozuv mashinkasi" kabi ochiladi.
 */
export function nextReveal(text: string, from: number, minStep = 24): number {
  const remaining = text.length - from;
  if (remaining <= 0) return text.length;
  const step = Math.max(minStep, Math.ceil(remaining / 3));
  if (step >= remaining) return text.length;
  let cut = from + step;
  const space = text.slice(cut, cut + 24).search(/\s/);
  if (space !== -1) cut += space;
  return Math.min(cut, text.length);
}

/**
 * Jonli (stream) javob guruhda: xabar yuboriladi, keyin tahrirlanib bosqichma-bosqich to'ldiriladi.
 * (sendMessageDraft — rasmiy stream — faqat shaxsiy chatlarda ishlaydi, bizning suhbatlar esa guruhlarda.)
 */
export class LiveMessage {
  private api: MessageApi;
  private chatId: number;
  private replyTo: number | undefined;
  private intervalMs: number;
  private thinkingMs: number;
  private budget: ChatBudget;
  private messageId: number | null = null;
  private received = "";
  private revealed = 0;
  private shown = "";
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private streaming = false;
  private frame = 0;
  private anim: NodeJS.Timeout | null = null;
  private reveal: NodeJS.Timeout | null = null;
  private typing: NodeJS.Timeout | null = null;
  /** Jarayon davomida ko'rinadigan tugmalar (masalan "⏹ To'xtatish"). Yakunda olib tashlanadi. */
  private controls: Button[][];
  /** Matn Markdown — Telegram HTML bo'lib chiqadi (agent javoblari). */
  private markdown: boolean;
  /** Rich message (Telegram'ning boy formati); rad etilsa — HTML'ga tushadi. */
  private rich: boolean;
  private richBroken = false;
  private htmlBroken = false;

  constructor(
    api: MessageApi,
    chatId: number,
    opts: {
      replyTo?: number;
      intervalMs?: number;
      thinkingMs?: number;
      budget?: ChatBudget;
      controls?: Button[][];
      markdown?: boolean;
      rich?: boolean;
    } = {},
  ) {
    this.api = api;
    this.chatId = chatId;
    this.replyTo = opts.replyTo;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.thinkingMs = opts.thinkingMs ?? 2000;
    this.budget = opts.budget ?? sharedBudget;
    this.controls = opts.controls ?? [];
    this.rich = (opts.rich ?? false) && !!api.sendRichMessage;
    this.markdown = (opts.markdown ?? false) || this.rich;
  }

  /** Ko'rsatiladigan matn. Rich -> HTML -> oddiy matn: biri rad etilsa, xabar oxirigacha keyingisi. */
  private render(raw: string, suffix = ""): View {
    if (this.rich && !this.richBroken) return { text: clip(raw), rich: clip(raw, RICH_LIMIT) + suffix };
    if (!this.markdown) return { text: clip(raw) + suffix };
    if (this.htmlBroken) return { text: clip(mdToPlain(raw)) + suffix };
    return { text: mdToHtml(clip(raw, MD_LIMIT)) + suffix, parse_mode: "HTML" };
  }

  private async send(view: View, extra: object): Promise<unknown> {
    if (view.rich !== undefined) {
      try {
        return this.messageId === null
          ? await this.api.sendRichMessage!(this.chatId, { markdown: view.rich }, { ...this.replyParams, ...extra })
          : await this.api.editMessageText(this.chatId, this.messageId, { markdown: view.rich }, extra);
      } catch (e) {
        const retryAfter = (e as { parameters?: { retry_after?: number } }).parameters?.retry_after;
        if (retryAfter || (e instanceof Error && e.message.includes("message is not modified"))) throw e;
        // Rich rad etildi — shu xabar oxirigacha HTML
        log.warn("rich message rejected, falling back to HTML", { error: errMessage(e) });
        this.richBroken = true;
        return this.send(this.render(view.text), extra);
      }
    }
    const go = (v: View) =>
      this.messageId === null
        ? this.api.sendMessage(this.chatId, v.text, { ...this.replyParams, ...extra, parse_mode: v.parse_mode })
        : this.api.editMessageText(this.chatId, this.messageId, v.text, { ...extra, parse_mode: v.parse_mode });
    try {
      return await go(view);
    } catch (e) {
      if (!view.parse_mode || !isParseError(e)) throw e;
      this.htmlBroken = true;
      return go({ text: view.text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") });
    }
  }

  /** Yuborilgan xabar ID'si (hali yuborilmagan bo'lsa null). */
  get id(): number | null {
    return this.messageId;
  }

  private get replyParams() {
    return this.replyTo ? { reply_parameters: { message_id: this.replyTo, allow_sending_without_reply: true } } : {};
  }

  /**
   * Javob kelguncha: "💭 O'ylayapman." → ".." → "..." animatsiyasi va sarlavhadagi "typing…" indikatori.
   * Birinchi haqiqiy matn kelishi bilan to'xtaydi.
   */
  startThinking(label: string) {
    if (this.closed || this.anim) return;
    let frame = 0;
    const tick = () => {
      if (this.closed || this.streaming) return;
      const text = `${label}${DOTS[frame++ % DOTS.length]}`;
      // birinchi kadr doim chiqadi; keyingilari — limit byudjeti bo'lsa
      if (frame > 1 && !this.budget.take(this.chatId)) return;
      if (frame === 1) this.budget.take(this.chatId, true);
      // navbatda turgan kadr matn kelgandan keyin chiqib qolmasin
      this.chain = this.chain.then(() => (this.streaming ? undefined : this.push(text, "", "thinking"))).catch(() => {});
    };
    tick();
    this.anim = setInterval(tick, this.thinkingMs);
    const typing = () => void this.api.sendChatAction?.(this.chatId, "typing").catch(() => {});
    typing();
    this.typing = setInterval(typing, TYPING_EVERY_MS);
  }

  private stopTimers() {
    for (const t of [this.anim, this.reveal, this.typing]) if (t) clearInterval(t);
    this.anim = this.reveal = this.typing = null;
  }

  /** Model shu paytgacha yozgan matn. Ko'rsatish bir maromda, alohida taymer bilan. */
  update(text: string) {
    if (this.closed || !text.trim()) return;
    this.received = text;
    if (!this.streaming) {
      this.streaming = true;
      if (this.anim) clearInterval(this.anim);
      this.anim = null;
      this.revealStep();
      this.reveal = setInterval(() => this.revealStep(), this.intervalMs);
    }
  }

  private revealStep(force = false) {
    if (this.revealed >= this.received.length) return;
    if (!this.budget.take(this.chatId, force)) return;
    this.revealed = nextReveal(this.received, this.revealed);
    const raw = this.received.slice(0, this.revealed);
    const cursor = CURSORS[this.frame++ % CURSORS.length]!;
    this.chain = this.chain.then(() => this.push(raw, cursor)).catch(() => {});
  }

  /** raw — xom matn; suffix — kursor; "thinking" — animatsiya kadri. */
  private async push(raw: string, suffix = "", kind: "content" | "thinking" = "content") {
    const view: View =
      kind === "content"
        ? this.render(raw, suffix)
        : this.rich && !this.richBroken
          ? { text: raw, rich: raw.replace(/^💭\s*/, `${THINK_EMOJI} `) }
          : { text: raw + suffix };
    const key = view.rich ?? view.text;
    if (key === this.shown) return;
    const markup = this.controls.length ? { reply_markup: keyboard(this.controls) } : {};
    const res = await this.send(view, markup).catch(ignoreNotModified);
    if (this.messageId === null && res && typeof res === "object" && "message_id" in res) {
      this.messageId = (res as { message_id: number }).message_id;
    }
    this.shown = key;
  }

  /**
   * Yakuniy matn va tugmalar. Matnning katta qismi hali ochilmagan bo'lsa — yana 1-2 qadam "yozib" beradi
   * (javob birdan tashlanmasin), keyin yakuniy holat. Stream bo'lmagan bo'lsa — oddiy yangi xabar.
   */
  async finish(text: string, buttons: Button[][] = []) {
    this.closed = true;
    this.stopTimers();
    const final = clip(text);
    if (this.streaming && final.startsWith(this.received.slice(0, this.revealed))) {
      this.received = final;
      for (let i = 0; i < 2 && this.revealed < final.length * 0.75; i++) {
        await sleep(this.intervalMs);
        this.revealStep();
      }
    }
    await this.chain;
    this.budget.take(this.chatId, true);
    const markup = { reply_markup: keyboard(buttons) };
    const view = this.render(text);
    if (this.messageId === null) {
      await this.send(view, markup);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.send(view, markup);
        return;
      } catch (e) {
        const retryAfter = (e as { parameters?: { retry_after?: number } }).parameters?.retry_after;
        if (e instanceof Error && e.message.includes("message is not modified")) return;
        if (!retryAfter) throw e;
        await sleep(retryAfter * 1000);
      }
    }
  }
}
