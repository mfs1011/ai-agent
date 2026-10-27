import { z } from "zod";

// Kanal posti: model faqat MA'LUMOT beradi (JSON), ko'rinishni esa kod doim bir xil, ixcham shablon bilan yig'adi.
// Shunda post har kuni toza, o'qishga qulay va bir uslubda chiqadi.

export const FeedItemSchema = z.object({
  title: z.string().describe("Qisqa sarlavha, 60 belgigacha. Vakansiyada — lavozim nomi"),
  url: z.string().describe("Aniq sahifa havolasi (maqola, reliz yoki aniq e'lon)"),
  summary: z.string().default("").describe("1-2 qisqa gap, 180 belgigacha: nima va nega muhim / asosiy talablar"),
  published: z.string().default("").describe("Manbadagi nashr/e'lon sanasi, YYYY-MM-DD. Sanani sahifadan aniq ol — taxmin qilma"),
  company: z.string().optional().describe("Faqat vakansiya: kompaniya nomi, e'londagidek"),
  location: z.string().optional().describe("Faqat vakansiya: shahar yoki Remote"),
  salary: z.string().optional().describe("Faqat vakansiya: maosh e'londa bo'lsa, masalan $3 400 – 4 100"),
  stack: z.array(z.string()).optional().describe("Faqat vakansiya: 3-5 ta asosiy texnologiya"),
});

export const FeedPostSchema = z.object({
  kind: z.enum(["news", "jobs"]).describe("news — yangiliklar, jobs — vakansiyalar"),
  emoji: z.string().default("📰").describe("Mavzuga mos bitta emoji"),
  title: z.string().describe("Post sarlavhasi, 3-5 so'z, sanasiz"),
  intro: z.string().default("").describe("Bir qisqa gap: bugungi postda nima bor, 100 belgigacha"),
  items: z.array(FeedItemSchema).describe("2-5 ta band. Yangi narsa bo'lmasa — bo'sh ro'yxat"),
  hashtags: z.array(z.string()).default([]).describe("2-4 ta teg, # belgisisiz"),
});

export type FeedItem = z.infer<typeof FeedItemSchema>;
export type FeedPost = z.infer<typeof FeedPostSchema>;

const NUMS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];

/** Model matnidagi Markdown belgilarini zararsizlantirish (shablon buzilmasin). */
function plain(s: string, max: number): string {
  const t = s
    .replace(/[\r\n]+/g, " ")
    .replace(/[*_`~|=[\]<>#]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** "Symfony 8.2 va Node.js" — bandlar sarlavhasining birinchi 2 so'zidan. */
function introFromItems(p: FeedPost): string {
  if (p.kind === "jobs") return `${p.items.length} ta vakansiya`;
  const heads = p.items.slice(0, 3).map((i) => plain(i.title, 70).split(/[:\s]+/).slice(0, 2).join(" "));
  const uniq = [...new Set(heads)];
  return uniq.length <= 1 ? uniq.join("") : `${uniq.slice(0, -1).join(", ")} va ${uniq.at(-1)}`;
}

const tag = (t: string) => t.replace(/[^\p{L}\p{N}_]/gu, "");

/**
 * Post (Markdown -> Telegram HTML). Tipografiya: har band orasida bo'sh qator (oq joy), 3 darajali ierarxiya
 * (qalin sarlavha -> kursiv sana/kirish -> bandlar), har band 2 qator: bosiladigan sarlavha + 1-2 qisqa gap.
 * Rich format emas: u bitta qator tashlashni bo'shliq deb o'qiydi va paragraflar orasida joy qoldirmaydi.
 */
export function renderFeedPost(p: FeedPost, dateLabel: string): string {
  const head = [`${plain(p.emoji, 4)} **${plain(p.title, 48)}**`];
  // Kirish — faqat postda haqiqatan qolgan bandlardan (model yozgan intro tashlangan bandlarni va'da qilishi mumkin)
  const sub = [dateLabel, introFromItems(p)].filter(Boolean).join(" · ");
  head.push(`_${sub}_`);
  const out: string[] = [head.join("\n")];

  p.items.slice(0, 4).forEach((it, i) => {
    const num = NUMS[i] ?? `${i + 1}.`;
    const block = [`${num} **[${plain(it.title, 70)}](${it.url})**`];
    if (p.kind === "jobs") {
      const meta = [it.company && `🏢 ${plain(it.company, 40)}`, it.location && `📍 ${plain(it.location, 30)}`].filter(Boolean);
      if (meta.length) block.push(meta.join("  ·  "));
      if (it.salary?.trim()) block.push(`💰 ==${plain(it.salary, 40)}==`);
      if (it.stack?.length) block.push(`🧩 ${it.stack.slice(0, 5).map((s) => `\`${plain(s, 20)}\``).join(" ")}`);
      if (it.summary.trim()) block.push(plain(it.summary, 160));
    } else {
      block.push(plain(it.summary, 160));
    }
    out.push(block.join("\n"));
  });

  const tags = p.hashtags.map(tag).filter(Boolean).slice(0, 4);
  // "#" bilan boshlangan qator sarlavha bo'lib qolmasligi uchun oldida belgi
  if (tags.length) out.push(`🏷 ${tags.map((t) => `#${t}`).join(" ")}`);
  return out.join("\n\n");
}

const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

export function dateLabel(localYmd: string): string {
  const [, m, d] = localYmd.split("-").map(Number) as [number, number, number];
  return `${d}-${MONTHS[m - 1]}`;
}

/** Yangilik — 14 kun, vakansiya — 30 kundan eski yoki sanasiz bandlar olib tashlanadi. */
export function keepFreshItems(p: FeedPost, todayYmd: string): { post: FeedPost; stale: FeedItem[] } {
  const maxDays = p.kind === "jobs" ? 30 : 14;
  const today = Date.parse(`${todayYmd}T00:00:00Z`);
  const fresh = (it: FeedItem) => {
    const t = Date.parse(`${it.published.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(t)) return false;
    const ageDays = (today - t) / 86_400_000;
    return ageDays >= -1 && ageDays <= maxDays;
  };
  return { post: { ...p, items: p.items.filter(fresh) }, stale: p.items.filter((i) => !fresh(i)) };
}
