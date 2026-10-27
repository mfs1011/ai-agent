import type { Db } from "../../db.ts";
import type { Config } from "../../config.ts";
import type { JobQueue } from "../../core/jobs.ts";
import type { Notifier } from "../../core/notify.ts";
import type { LlmRunner } from "../../llm/types.ts";
import { z } from "zod";
import type { FeedItem, FeedPost } from "./post.ts";
import type { JobCandidate } from "./job-sources.ts";
import { collectJobs } from "./job-sources.ts";
import { FeedPostSchema, dateLabel, keepFreshItems, renderFeedPost } from "./post.ts";
import { log } from "../../log.ts";
import { localDate, nowContext } from "../../core/time.ts";
import type { Feed } from "./repo.ts";
import { dueFeeds, getFeed, recentPostTexts, recordPost, updateFeed } from "./repo.ts";

export const JOB_FEEDS_HOURLY = "feeds.hourly";
export const JOB_FEED_POST = "feeds.post";

const SYSTEM = `Sen Telegram kanali muharririsan. Berilgan mavzu bo'yicha internetdan eng so'nggi va foydali ma'lumotlarni topasan. Postni kod chiroyli qilib yig'adi — sen faqat MA'LUMOTni JSON'da berasan.

Qoidalar:
- Faqat web qidiruvda haqiqatan topgan va ochib ko'rgan ma'lumot. O'ylab topma, "namuna" yoki umumlashtirilgan band yozma. Fayl o'qima/yozma, terminal ishlatma.
- url'ni HECH QACHON o'zing yasama yoki taxmin qilma — faqat haqiqatan ochgan sahifangning aniq manzilini harfma-harf ko'chir (yasalgan havolalar tekshiruvda 404 beradi va band tashlanadi).
- Har bir band url'i — aniq sahifa: maqola, reliz, aniq e'lon (yoki shu kompaniyaning vakansiyalar sahifasi). Qidiruv natijalari (search, ?q=, ?text=), bosh sahifa yoki saytning umumiy ro'yxati MUMKIN EMAS.
- Vakansiyada kompaniya va maosh e'londa qanday bo'lsa, shunday; maosh yo'q bo'lsa — salary bermaslik.
- Vakansiya manbalari (aniq e'lon havolasi bilan): hh.uz/vacancy/…, career.habr.com/vacancies/…, djinni.co/jobs/…, larajobs.com, vuejobs.com, weworkremotely.com, remoteok.com, ` +
  `va O'zbekistondagi IT vakansiya Telegram kanallari postlari (t.me/kanal/123 — har bir e'lonning o'z havolasi).
- Faqat YANGI narsa: yangiliklar — oxirgi 14 kun ichida, vakansiyalar — oxirgi 30 kun ichida e'lon qilingan. Har bandga manbadagi aniq sanani (published) yoz; eski reliz va maqolalar MUMKIN EMAS.
- Avval chiqqan postlarda bo'lgan narsani takrorlama. Aniq manbasi topilmagan bandni qo'shma: 2 ta haqiqiy band 5 ta shubhalidan yaxshi.
- Til: o'zbekcha (lotin), qisqa va jonli. summary — 1-2 qisqa gap, keraksiz so'zlarsiz.
- Yangi va foydali narsa topilmasa — items bo'sh ro'yxat.`;

const LINK_RE = /\]\((https?:\/\/[^)\s]+)\)/g;
/**
 * Qidiruv sahifalari va saytning umumiy ro'yxatlari — aniq manba emas.
 * Aniq kompaniyaning vakansiyalari sahifasi (/companies/x/vacancies) esa manba sifatida qabul qilinadi.
 */
function isGenericUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if ([...u.searchParams.keys()].some((k) => /^(q|text|query|search|keyword|s)$/i.test(k))) return true;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.some((p) => /^search$/i.test(p))) return true;
  if (segs.length === 0) return true; // bosh sahifa
  return segs.length === 1 && /^(vacancies|vacancy|jobs|careers|news|blog)$/i.test(segs[0]!);
}

export type LinkCheck = { url: string; ok: boolean; reason?: string };

/** Postdagi havolalarni tekshiradi: aniq sahifami va ochiladimi. */
export async function checkLinks(markdown: string, fetchFn: typeof fetch = fetch): Promise<LinkCheck[]> {
  const urls = [...new Set([...markdown.matchAll(LINK_RE)].map((m) => m[1]!))];
  return Promise.all(
    urls.map(async (url): Promise<LinkCheck> => {
      if (isGenericUrl(url)) return { url, ok: false, reason: "qidiruv/ro'yxat sahifasi" };
      try {
        const res = await fetchFn(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(12_000) });
        // 401/403 — ko'p saytlar botlarni bloklaydi, lekin sahifa mavjud
        return res.ok || res.status === 401 || res.status === 403 ? { url, ok: true } : { url, ok: false, reason: `HTTP ${res.status}` };
      } catch (e) {
        return { url, ok: false, reason: e instanceof Error ? e.name : "xato" };
      }
    }),
  );
}

function safeJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** Model'dan post ma'lumotlarini oladi (JSON sxema). Yangi narsa bo'lmasa — null. */
export async function composePost(llm: LlmRunner, feed: Feed, tzOffsetMin: number, previous: string[]): Promise<FeedPost | null> {
  // agy o'zining web qidiruvidan foydalanadi (headless rejimda ruxsat talab qilmaydi).
  const { $schema: _s, ...schema } = z.toJSONSchema(FeedPostSchema, { io: "input" }) as Record<string, unknown>;
  const prompt =
    `${SYSTEM}\n\nBugun: ${nowContext(new Date(), tzOffsetMin)}\n\nMavzu: ${feed.topic}\n\n` +
    `Avvalgi postlar (takrorlama):\n${previous.map((p) => `---\n${p.slice(0, 600)}`).join("\n") || "(yo'q)"}`;
  // Model ba'zan sxemaga mos kelmaydigan javob beradi — bir marta qayta so'raymiz
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.run({ timeoutMs: 5 * 60_000, schema, prompt });
    const raw = res.json ?? safeJson(res.text);
    const parsed = FeedPostSchema.safeParse(raw);
    if (parsed.success) return parsed.data.items.length ? parsed.data : null;
    lastError = `${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} | ${JSON.stringify(raw ?? res.text).slice(0, 300)}`;
    log.warn("feed response invalid, retrying", { feedId: feed.id, attempt, error: lastError });
  }
  throw new Error(`Feed javobini o'qib bo'lmadi: ${lastError}`);
}

const RepairSchema = z.object({
  fixes: z.array(z.object({ index: z.number().int(), url: z.string().nullable() })),
});

/**
 * 404 bergan havolalarni tiklash: model ba'zan URL'ni taxmin qilib yozadi. Maqola nomi bo'yicha qidirib,
 * aniq manzilni topishni so'raymiz; topilgani qayta tekshiriladi.
 */
export async function repairLinks(llm: LlmRunner, items: FeedItem[], fetchFn: typeof fetch = fetch): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const { $schema: _s, ...schema } = z.toJSONSchema(RepairSchema) as Record<string, unknown>;
  const res = await llm.run({
    timeoutMs: 3 * 60_000,
    schema,
    prompt:
      "Quyidagi maqola/e'lonlar havolalari ochilmadi (404). Har biri uchun web qidiruv bilan haqiqiy sahifani top va " +
      "brauzer manzil satridagi aniq URL'ni harfma-harf ko'chir. Topilmasa — url: null. Taxmin qilma.\n\n" +
      items.map((it, i) => `${i}. "${it.title}" (noto'g'ri: ${it.url})`).join("\n"),
  });
  const parsed = RepairSchema.safeParse(res.json);
  if (!parsed.success) return new Map();
  const candidates = parsed.data.fixes.filter((f) => f.url && items[f.index]);
  const checks = await checkLinks(candidates.map((f) => `[x](${f.url})`).join(" "), fetchFn);
  const good = new Set(checks.filter((c) => c.ok).map((c) => c.url));
  return new Map(candidates.filter((f) => good.has(f.url!)).map((f) => [items[f.index]!.url, f.url!]));
}

const VerifySchema = z.object({
  results: z.array(z.object({ index: z.number().int(), exists: z.boolean(), page_title: z.string().optional() })),
});

/**
 * Oddiy so'rovga 404/403 beradigan saytlar (hh.uz va h.k.) ko'p — ular botlarni bloklaydi, sahifa esa mavjud.
 * Bunday havolalarni agy o'z brauzeri bilan ochib tekshiradi: sahifa bormi va aynan shu bandga tegishlimi.
 */
export async function verifyWithAgy(llm: LlmRunner, items: FeedItem[]): Promise<Set<string>> {
  if (items.length === 0) return new Set();
  const { $schema: _s, ...schema } = z.toJSONSchema(VerifySchema) as Record<string, unknown>;
  const res = await llm.run({
    timeoutMs: 3 * 60_000,
    schema,
    prompt:
      "Quyidagi har bir URL'ni ochib ko'r. Sahifa haqiqatan mavjud va aynan shu sarlavhadagi maqola/e'longa tegishli bo'lsa — exists: true " +
      "va page_title (sahifadagi sarlavha). 404, o'chirilgan e'lon, bosh sahifa yoki boshqa narsa bo'lsa — exists: false. Taxmin qilma, faqat ochib ko'rganingni yoz.\n\n" +
      items.map((it, i) => `${i}. "${it.title}" — ${it.url}`).join("\n"),
  });
  const parsed = VerifySchema.safeParse(res.json);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.results.filter((r) => r.exists && items[r.index]).map((r) => items[r.index]!.url));
}

/** Vakansiya feedimi (mavzu bo'yicha). */
export function isJobsFeed(topic: string): boolean {
  return /vakans|ish o['‘’]?rni|ishga olish|job|hiring|career/i.test(topic);
}

const PickSchema = z.object({
  title: z.string().default("Vakansiyalar").describe("Post sarlavhasi, 2-4 so'z, sanasiz"),
  hashtags: z.array(z.string()).default([]),
  picks: z.array(
    z.object({
      id: z.string().describe("Tanlangan vakansiya id'si — ro'yxatdagidek, aynan"),
      title: z.string().describe("Lavozim nomi — manbadagidek (tarjima qilma)"),
      summary: z.string().describe("O'zbekcha 1-2 qisqa gap: asosiy talablar va nima qiladi, 160 belgigacha"),
      stack: z.array(z.string()).default([]).describe("3-5 ta asosiy texnologiya, matnda bo'lsa"),
      company: z.string().optional().describe("Faqat Telegram e'lonida: matnda yozilgan kompaniya nomi"),
      salary: z.string().optional().describe("Faqat matnda yozilgan bo'lsa"),
    }),
  ),
});

/**
 * Vakansiya posti: model haqiqiy nomzodlardan eng moslarini tanlaydi va o'zbekcha izoh yozadi.
 * Havola, sana, joy (va manbada bo'lsa kompaniya/maosh) — manbadan; model ularni o'zgartira olmaydi.
 */
export async function composeJobsPost(llm: LlmRunner, feed: Feed, candidates: JobCandidate[]): Promise<FeedPost | null> {
  if (candidates.length === 0) return null;
  const list = candidates.slice(0, 40);
  const { $schema: _s, ...schema } = z.toJSONSchema(PickSchema, { io: "input" }) as Record<string, unknown>;
  const res = await llm.run({
    timeoutMs: 3 * 60_000,
    schema,
    prompt:
      `Sen IT vakansiyalar kanali muharririsan. Mavzu: ${feed.topic}\n\n` +
      `Quyidagi HAQIQIY vakansiyalardan mavzuga eng mos 3-5 tasini tanla (mos kelmasa — kamroq, umuman yo'q bo'lsa — bo'sh). ` +
      `Remote'da O'zbekistondan ishlash mumkin bo'lganlarini (Worldwide, EMEA, Europe) afzal ko'r; faqat AQSh fuqarolari uchun bo'lsa — tanlama. ` +
      `Faqat ro'yxatdagi ma'lumotga tayan, hech narsa qo'shib to'qima. Fayl o'qima, internetga chiqma.\n\n` +
      list
        .map(
          (c) =>
            `[${c.id}] ${c.title}${c.company ? ` — ${c.company}` : ""} | ${c.location ?? ""} | ${c.published}${c.salary ? ` | ${c.salary}` : ""}\n${c.text.slice(0, 400)}`,
        )
        .join("\n\n"),
  });
  const parsed = PickSchema.safeParse(res.json);
  if (!parsed.success) throw new Error(`Vakansiya tanlovini o'qib bo'lmadi: ${res.text.slice(0, 200)}`);
  const byId = new Map(list.map((c) => [c.id, c]));
  const items = parsed.data.picks
    .filter((p) => byId.has(p.id))
    .slice(0, 5)
    .map((p) => {
      const c = byId.get(p.id)!;
      return {
        title: c.source === "telegram" ? p.title : c.title,
        url: c.url,
        published: c.published,
        summary: p.summary,
        // Kompaniya va maosh: rasmiy manbada — faqat manbadan; Telegram e'lonida — e'lon matnidan (model o'qib beradi)
        company: c.source === "telegram" ? p.company : c.company,
        location: c.location,
        salary: c.source === "telegram" ? p.salary : c.salary,
        stack: p.stack,
      };
    });
  if (items.length === 0) return null;
  return { kind: "jobs", emoji: "💼", title: parsed.data.title, intro: "", items, hashtags: parsed.data.hashtags };
}

/** Avval chiqqan postlardagi havolalar (qayta chiqmasin). */
export function postedUrls(texts: string[]): Set<string> {
  return new Set(texts.flatMap((t) => [...t.matchAll(/\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!)));
}

/** Har bir band havolasini tekshiradi: yaroqsizlari olib tashlanadi. */
export async function keepVerifiedItems(post: FeedPost, fetchFn: typeof fetch = fetch): Promise<{ post: FeedPost; dropped: LinkCheck[] }> {
  const checks = await checkLinks(post.items.map((i) => `[x](${i.url})`).join(" "), fetchFn);
  const bad = new Map(checks.filter((c) => !c.ok).map((c) => [c.url, c]));
  return { post: { ...post, items: post.items.filter((i) => !bad.has(i.url)) }, dropped: [...bad.values()] };
}

export function registerFeedJobs(deps: {
  db: Db;
  config: Config;
  llm: LlmRunner;
  jobs: JobQueue;
  notifier: Notifier;
  /** Avtomatik post rad etilsa — qayerga xabar (ishchi guruh). */
  alertChat?: () => number | null;
}) {
  const { db, config, llm, jobs, notifier } = deps;

  // Har soat boshida: shu soatga belgilangan feedlarni navbatga qo'yadi.
  jobs.register(JOB_FEEDS_HOURLY, async () => {
    try {
      const now = new Date();
      const localHour = new Date(now.getTime() + config.TZ_OFFSET_MINUTES * 60_000).getUTCHours();
      const today = localDate(now, config.TZ_OFFSET_MINUTES);
      for (const f of dueFeeds(db, localHour, today)) {
        updateFeed(db, f.id, { last_run_on: today });
        jobs.enqueue(JOB_FEED_POST, { feedId: f.id });
      }
    } finally {
      scheduleHourly(jobs);
    }
  });

  jobs.register(
    JOB_FEED_POST,
    async (job) => {
      const { feedId, reportChatId } = job.payload as { feedId: number; reportChatId?: number };
      const feed = getFeed(db, feedId);
      if (!feed) return;
      const today = localDate(new Date(), config.TZ_OFFSET_MINUTES);
      // Vakansiyalar — rasmiy manbalardan (havola to'qib bo'lmaydi), tekshiruv shart emas
      if (isJobsFeed(feed.topic)) {
        const candidates = await collectJobs({
          topic: feed.topic,
          telegramChannels: (feed.sources ?? "").split(",").map((x) => x.trim()).filter(Boolean),
          todayYmd: today,
          postedUrls: postedUrls(recentPostTexts(db, feed.id, 50)),
        });
        const jobsPost = await composeJobsPost(llm, feed, candidates);
        if (!jobsPost) {
          if (reportChatId) await notifier.send(reportChatId, `Feed #${feed.id}: mos yangi vakansiya topilmadi (${candidates.length} ta nomzod ko'rildi).`);
          return;
        }
        const jobsBody = renderFeedPost(jobsPost, dateLabel(today));
        const jobsMsg = await notifier.send(feed.channel_id, jobsBody);
        recordPost(db, { feedId: feed.id, channelId: feed.channel_id, messageId: jobsMsg, text: jobsBody });
        if (reportChatId) await notifier.send(reportChatId, `✅ Feed #${feed.id} kanalga joylandi (${jobsPost.items.length} ta vakansiya).`);
        return;
      }
      const draft = await composePost(llm, feed, config.TZ_OFFSET_MINUTES, recentPostTexts(db, feed.id));
      if (!draft) {
        if (reportChatId) await notifier.send(reportChatId, `Feed #${feed.id}: yangi narsa topilmadi.`);
        return;
      }
      // Eski va havolasi shubhali bandlar olib tashlanadi; birorta ham ishonchli band qolmasa — post chiqmaydi
      const { post: freshPost, stale } = keepFreshItems(draft, today);
      if (stale.length) log.warn("feed items dropped: stale", { feedId: feed.id, stale: stale.map((s) => `${s.published} ${s.title}`) });
      let { post, dropped } = await keepVerifiedItems(freshPost);
      // Oddiy tekshiruvdan o'tmaganlar (bot bloki bo'lishi mumkin) — agy ochib tekshiradi
      const unreachable = freshPost.items.filter((i) => dropped.some((d) => d.url === i.url && !d.reason?.includes("qidiruv")));
      const confirmed = await verifyWithAgy(llm, unreachable).catch(() => new Set<string>());
      if (confirmed.size) {
        const order0 = new Map(freshPost.items.map((i, k) => [i.url, k]));
        post = { ...post, items: [...post.items, ...unreachable.filter((i) => confirmed.has(i.url))].sort((a, b) => order0.get(a.url)! - order0.get(b.url)!) };
        dropped = dropped.filter((d) => !confirmed.has(d.url));
        log.info("feed links confirmed by agy", { feedId: feed.id, confirmed: [...confirmed] });
      }
      // Hali ham ochilmaganlarni bir marta tiklashga urinamiz (qidiruv/ro'yxat sahifalari emas — ular tiklanmaydi)
      const broken = freshPost.items.filter((i) => dropped.some((d) => d.url === i.url && d.reason?.startsWith("HTTP")));
      const fixed = await repairLinks(llm, broken).catch(() => new Map<string, string>());
      if (fixed.size) {
        const repaired = broken.filter((i) => fixed.has(i.url)).map((i) => ({ ...i, url: fixed.get(i.url)! }));
        const order = new Map(freshPost.items.map((i, k) => [i.title, k]));
        post = { ...post, items: [...post.items, ...repaired].sort((a, b) => order.get(a.title)! - order.get(b.title)!) };
        dropped = dropped.filter((d) => !fixed.has(d.url));
        log.info("feed links repaired", { feedId: feed.id, repaired: [...fixed.values()] });
      }
      if (dropped.length) log.warn("feed items dropped: bad links", { feedId: feed.id, dropped });
      if (post.items.length === 0) {
        const alertTo = reportChatId ?? deps.alertChat?.() ?? null;
        if (alertTo) {
          await notifier.send(
            alertTo,
            `⚠️ Feed #${feed.id}: post kanalga yuborilmadi — yangi va ishonchli manba topilmadi:\n` +
              [
                ...stale.map((s) => `- ${s.title} — eski (${s.published || "sanasiz"})`),
                ...dropped.map((b) => `- \`${b.url.slice(0, 80)}\` — ${b.reason}`),
              ].join("\n"),
          );
        }
        return;
      }
      const body = renderFeedPost(post, dateLabel(today));
      // Oddiy HTML: bo'sh qatorlar (oq joy) aynan saqlanadi
      const messageId = await notifier.send(feed.channel_id, body);
      recordPost(db, { feedId: feed.id, channelId: feed.channel_id, messageId, text: body });
      if (reportChatId) await notifier.send(reportChatId, `✅ Feed #${feed.id} kanalga joylandi.`);
    },
    1,
  );

  if (!jobs.hasPending(JOB_FEEDS_HOURLY)) scheduleHourly(jobs);
}

function scheduleHourly(jobs: JobQueue) {
  const next = new Date();
  next.setUTCMinutes(0, 5, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  jobs.enqueue(JOB_FEEDS_HOURLY, {}, { runAt: next });
}
