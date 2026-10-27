// LLM qatlami interfeyslari. Bot faqat shularga bog'liq — provider (agy, claude, ...) almashtirilishi mumkin.

export type LlmRequest = {
  prompt: string;
  /** JSON Schema: berilsa, javob shu sxema bo'yicha `json` maydonida qaytadi. */
  schema?: object;
  model?: string;
  /** Ishchi papka. Berilmasa — bo'sh sandbox papka. */
  cwd?: string;
  /** Fayllarni tahrirlashga ruxsat (faqat kod yozuvchi agent uchun). */
  allowEdits?: boolean;
  timeoutMs?: number;
  /** Berilsa, javob bo'lak-bo'lak keladi: har safar shu paytgacha yig'ilgan matn bilan chaqiriladi. */
  onDelta?: (textSoFar: string) => void;
  /** Bekor qilish (foydalanuvchi "⏹ To'xtatish"ni bosdi): jarayon o'ldiriladi, AbortedError otiladi. */
  signal?: AbortSignal;
};

export type LlmResult = {
  text: string;
  json: unknown;
  /** Headless rejimda rad etilgan amallar (masalan "command", "write_file"). */
  denied: string[];
};

export interface LlmRunner {
  run(req: LlmRequest): Promise<LlmResult>;
}

export type CodingResult = { ok: boolean; summary: string; costUsd?: number };

/** Berilgan papkada kod o'zgartiradigan agent. Commit/push qilmaydi — buni tizim o'zi qiladi. */
export interface CodingAgent {
  readonly name: string;
  implement(prompt: string, cwd: string, timeoutMs: number): Promise<CodingResult>;
}
