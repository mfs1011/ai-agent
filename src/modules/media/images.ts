import { mkdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ToolModule } from "../../core/agent.ts";
import { defineTool } from "../../core/tools.ts";
import type { LlmRunner } from "../../llm/types.ts";

// Rasm yaratish — agy CLI orqali (API kalitlarsiz, limitsiz). ~50 soniya.
// agy har so'rov uchun alohida vaqtinchalik papkada ishlaydi va faqat shu papkaga yozadi; papka keyin o'chiriladi.

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export async function generateImage(llm: LlmRunner, baseDir: string, prompt: string, signal?: AbortSignal): Promise<Buffer> {
  const root = resolve(baseDir);
  mkdirSync(root, { recursive: true });
  const dir = await mkdtemp(join(root, "img-"));
  try {
    const res = await llm.run({
      cwd: dir,
      allowEdits: true,
      timeoutMs: 4 * 60_000,
      signal,
      prompt:
        `Rasm yaratish vositang bilan quyidagi rasmni yarat:\n${prompt}\n\n` +
        `Natijani joriy papkaga image.png nomi bilan saqla. Boshqa fayl yozma, terminal ishlatma, boshqa papkalarga tegma. ` +
        `Javobda faqat fayl nomini yoz.`,
    });
    const files = (await readdir(dir)).filter((f) => IMAGE_EXT.test(f));
    if (files.length === 0) throw new Error(`Rasm yaratilmadi${res.text ? `: ${res.text.slice(0, 200)}` : ""}`);
    // Bir nechta bo'lsa — eng kattasi (asosiy rasm)
    const sized = await Promise.all(files.map(async (f) => ({ f, size: (await stat(join(dir, f))).size })));
    sized.sort((a, b) => b.size - a.size);
    return await readFile(join(dir, sized[0]!.f));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function mediaTools(deps: { llm: LlmRunner; baseDir: string }): ToolModule {
  return (ctx) => [
    defineTool({
      name: "image_generate",
      description:
        "Matn tavsifi bo'yicha rasm yaratadi va chatga yuboradi (~1 daqiqa). Rasm, surat, logo, illyustratsiya, avatar so'ralganda chaqiring. " +
        "prompt — batafsil tavsif (ingliz tilida yaxshiroq chiqadi): obyekt, uslub, rang, fon, kompozitsiya. " +
        "Javob matnida: rasm tayyorlanayotganini qisqa ayt.",
      input: z.object({
        prompt: z.string().min(3).describe("Rasm tavsifi, iloji boricha batafsil"),
        caption: z.string().optional().describe("Rasm ostidagi qisqa izoh (o'zbekcha)"),
      }),
      run: async (input) => {
        const png = await generateImage(deps.llm, deps.baseDir, input.prompt, ctx.signal);
        // Photo izohi Telegram HTML sifatida yuboriladi — escape
        const caption = input.caption?.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        ctx.photos.push({ png, caption: caption ? `🎨 ${caption}` : undefined });
        return JSON.stringify({ ok: true, sent_to_chat: true });
      },
    }),
  ];
}
