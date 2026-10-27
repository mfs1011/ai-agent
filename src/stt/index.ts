import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { LlmRunner } from "../llm/types.ts";

// Ovoz -> matn. Provider almashtirish uchun faqat shu interfeysni amalga oshirish kifoya.
export type TranscribeOpts = {
  filename: string;
  mimeType: string;
  vocabulary: string[];
  /** Ixtiyoriy: eshitilgan matn bo'lak-bo'lak (stream qila oladigan provayderlar uchun). */
  onPartial?: (textSoFar: string) => void;
  signal?: AbortSignal;
};

export interface SttProvider {
  transcribe(audio: Buffer, opts: TranscribeOpts): Promise<string>;
}

export function sttPrompt(vocabulary: string[]): string {
  return [
    "Bu Telegram ovozli xabari. Eshitilgan gapni so'zma-so'z matnga o'gir.",
    "Til: o'zbekcha (ba'zan rus so'zlari aralash). O'zbek lotin alifbosida yoz.",
    "Summalarni raqam bilan yoz (masalan 25 000).",
    vocabulary.length ? `Uchrashi mumkin bo'lgan so'zlar: ${vocabulary.join(", ")}.` : "",
    "Faqat matnning o'zini qaytar — izoh, tarjima yoki qo'shtirnoqsiz. Nutq bo'lmasa, bo'sh javob qaytar.",
  ]
    .filter(Boolean)
    .join("\n");
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

/** Model ba'zan javobni qo'shtirnoq yoki «» ichida qaytaradi — olib tashlaymiz. */
export function cleanTranscript(text: string): string {
  return text
    .trim()
    .replace(/^["«“']+|["»”']+$/g, "")
    .trim();
}

/**
 * agy CLI orqali: audio vaqtinchalik papkaga yoziladi, agy uni o'qib matnga o'giradi.
 * API limiti yo'q (agy obunasi), lekin sekinroq (~10 s). Papka har so'rovdan keyin o'chiriladi.
 */
export class AgyStt implements SttProvider {
  private llm: LlmRunner;
  private baseDir: string;
  private model: string | undefined;

  constructor(llm: LlmRunner, baseDir: string, model?: string) {
    this.llm = llm;
    this.baseDir = resolve(baseDir);
    this.model = model;
    mkdirSync(this.baseDir, { recursive: true });
  }

  async transcribe(audio: Buffer, opts: TranscribeOpts): Promise<string> {
    const dir = await mkdtemp(join(this.baseDir, "voice-"));
    try {
      const file = `voice.${EXT_BY_MIME[opts.mimeType] ?? "ogg"}`;
      await writeFile(join(dir, file), audio);
      const res = await this.llm.run({
        cwd: dir,
        model: this.model,
        timeoutMs: 90_000,
        prompt: `${file} faylida ovozli xabar bor. Uni tingla.\n${sttPrompt(opts.vocabulary)}\nBoshqa fayllarni o'qima, buyruq ishga tushirma.`,
        onDelta: opts.onPartial ? (soFar) => opts.onPartial!(cleanTranscript(soFar)) : undefined,
        signal: opts.signal,
      });
      return cleanTranscript(res.text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Ovoz — faqat agy CLI orqali (API kalitlarsiz, limitsiz). */
export function createStt(config: Config, llm: LlmRunner): SttProvider {
  return new AgyStt(llm, resolve(config.AGY_SANDBOX_DIR, "stt"), config.STT_AGY_MODEL || undefined);
}

export function sttVocabulary(config: Config, extra: string[]): string[] {
  const base = config.STT_VOCABULARY.split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...base, ...extra])];
}
