import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Db } from "../../db.ts";
import type { Button } from "../../core/agent.ts";
import { run } from "../../core/exec.ts";
import type { Notifier } from "../../core/notify.ts";
import { clip } from "../../core/notify.ts";
import type { LlmRunner } from "../../llm/types.ts";
import type { Suggestion } from "./repo.ts";
import { feedbackHistory, insertSuggestion } from "./repo.ts";

const SuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      title: z.string().describe("Qisqa nom, 70 belgigacha"),
      problem: z.string().describe("Qanday muammo yoki imkoniyat, 1-3 gap"),
      proposal: z.string().describe("Aniq nima qilinadi: qaysi fayl/modul, qanday xulq. Dasturchi shu matn bo'yicha bajara olishi kerak"),
      effort: z.enum(["S", "M", "L"]).describe("S: bir necha soat, M: 1 kun, L: bir necha kun"),
      area: z.string().describe("Masalan: finance, voice, bot, ideas, feeds, infra, tests, docs"),
    }),
  ),
});

const SYSTEM = `Sen shu loyihaning texnik rahbarisan. Vazifang — loyihani rivojlantirish uchun aniq, bajariladigan takliflar berish.

Qoidalar:
- Har bir taklif bitta PR'da bajariladigan hajmda bo'lsin. L darajadagini kamroq ber.
- Mavjud kod va yo'l xaritasiga tayan (kerak bo'lsa ishchi papkadagi fayllarni o'qi). Allaqachon bajarilgan yoki rad etilgan narsani qayta taklif qilma.
- Foydalanuvchi "liked" degan yo'nalishlarga yaqinroq, "disliked" deganlaridan uzoqroq takliflar ber.
- Foydali ish birinchi: ishonchlilik, foydalanuvchi uchun yangi imkoniyat, testlar. Kosmetik o'zgarishlar keyin.
- Server kuchsiz (2 vCPU, 4 GB RAM): og'ir servis yoki lokal AI model taklif qilma.
- Faylga yozma va buyruq ishga tushirma — faqat o'qi va taklif ber.
- Hammasi o'zbek tilida.`;

async function readIfExists(path: string, max = 8000): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    return text.length > max ? text.slice(0, max) + "\n…" : text;
  } catch {
    return null;
  }
}

async function projectContext(repoPath: string): Promise<string> {
  const parts: string[] = [];
  for (const file of ["README.md", "docs/ROADMAP.md"]) {
    const text = await readIfExists(join(repoPath, file));
    if (text) parts.push(`### ${file}\n${text}`);
  }
  const gitLog = await run("git", ["log", "--oneline", "-20"], { cwd: repoPath }).catch(() => null);
  if (gitLog?.code === 0) parts.push(`### Oxirgi commitlar\n${gitLog.stdout}`);
  return parts.join("\n\n");
}

export async function generateSuggestions(deps: {
  db: Db;
  llm: LlmRunner;
  model: string;
  repoPath: string;
  count: number;
}): Promise<Suggestion[]> {
  const history = feedbackHistory(deps.db);
  const historyText = history.length ? history.map((h) => `- [${h.status}] ${h.title}`).join("\n") : "(hali taklif berilmagan)";

  const { $schema: _s, ...schema } = z.toJSONSchema(SuggestionsSchema) as Record<string, unknown>;
  const res = await deps.llm.run({
    model: deps.model,
    cwd: deps.repoPath, // agent kodni o'zi o'qib ko'rishi mumkin; yozish headless rejimda bloklangan
    schema,
    timeoutMs: 10 * 60_000,
    prompt:
      `${SYSTEM}\n\n## Loyiha\n${await projectContext(deps.repoPath)}\n\n` +
      `## Avvalgi takliflar va baholar\n${historyText}\n\n${deps.count} ta yangi taklif ber.`,
  });

  const parsed = SuggestionsSchema.safeParse(res.json);
  if (!parsed.success) throw new Error(`Takliflar formatini o'qib bo'lmadi: ${res.text.slice(0, 300)}`);
  return parsed.data.suggestions.slice(0, deps.count).map((s) => insertSuggestion(deps.db, s));
}

const EFFORT: Record<string, string> = { S: "🟢 kichik", M: "🟡 o'rta", L: "🔴 katta" };

/** Markdown — notifier va bot uni Telegram HTML qilib yuboradi. */
export function formatSuggestion(s: Suggestion): string {
  return clip(
    `💡 **Taklif #${s.id}: ${s.title}**\n` +
      `${EFFORT[s.effort] ?? s.effort} · \`${s.area}\`\n\n` +
      `**Muammo**\n${s.problem}\n\n` +
      `**Yechim**\n${s.proposal}`,
  );
}

export function voteButtons(id: number): Button[][] {
  return [
    [
      { text: "👍 Yoqdi", data: `sg:like:${id}`, style: "success" },
      { text: "👎 Yoqmadi", data: `sg:dislike:${id}`, style: "danger" },
    ],
  ];
}

export function likedButtons(id: number): Button[][] {
  return [
    [
      { text: "▶️ Bajar", data: `sg:do:${id}`, style: "success" },
      { text: "👎 Fikrim o'zgardi", data: `sg:dislike:${id}` },
    ],
  ];
}

export async function sendSuggestions(notifier: Notifier, chatId: number, list: Suggestion[]) {
  for (const s of list) await notifier.send(chatId, formatSuggestion(s), voteButtons(s.id));
}
