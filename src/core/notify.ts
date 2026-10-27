import type { Button } from "./agent.ts";

/** Fon ishlaridan Telegram'ga xabar yuborish uchun. Bot'ga to'g'ridan bog'lanmaslik — test qilish oson. */
export interface Notifier {
  send(chatId: number, text: string, buttons?: Button[][]): Promise<number>;
  edit(chatId: number, messageId: number, text: string, buttons?: Button[][]): Promise<void>;
  /**
   * Rich message (Telegram'ning boy formati: katta sarlavhalar, jadval, ==marker==, yig'iladigan bloklar).
   * Rad etilsa — oddiy formatlangan xabar sifatida yuboriladi.
   */
  sendRich(chatId: number, markdown: string, buttons?: Button[][]): Promise<number>;
}

/** Rich message matni chegarasi (Telegram: 32768). */
export const RICH_LIMIT = 30000;

export const TELEGRAM_LIMIT = 4000;

export function clip(text: string, max = TELEGRAM_LIMIT): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
