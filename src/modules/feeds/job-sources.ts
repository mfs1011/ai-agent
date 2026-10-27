// Vakansiyalar — rasmiy ochiq manbalardan (model qidirmaydi va havola yozmaydi):
//   Remotive (ochiq API), We Work Remotely (RSS), Telegram kanallarining ochiq web-ko'rinishi (t.me/s/kanal).
// Havola, kompaniya, sana — manbadan; model faqat eng moslarini tanlab, qisqa izoh yozadi.

export type JobCandidate = {
  id: string;
  source: "remotive" | "wwr" | "telegram";
  title: string;
  company?: string;
  location?: string;
  salary?: string;
  url: string;
  published: string; // YYYY-MM-DD
  text: string; // qisqa tavsif (model uchun)
};

type FetchFn = typeof fetch;

const strip = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

const ymd = (d: string) => {
  const t = Date.parse(d);
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
};

/** Mavzudan texnologiya kalit so'zlari (Remotive qidiruvi uchun). */
const TECH = ["vue", "nuxt", "react", "next.js", "node", "nestjs", "laravel", "php", "symfony", "typescript", "javascript", "python", "django", "golang", "java", "kotlin", "flutter"];
export function techKeywords(topic: string): string[] {
  const t = topic.toLowerCase();
  return TECH.filter((k) => t.includes(k.replace(".js", ""))).slice(0, 6);
}

export async function fetchRemotive(queries: string[], fetchFn: FetchFn = fetch): Promise<JobCandidate[]> {
  const out: JobCandidate[] = [];
  for (const q of queries) {
    const res = await fetchFn(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=30`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res?.ok) continue;
    const data = (await res.json().catch(() => null)) as {
      jobs?: { id: number; title: string; company_name: string; candidate_required_location?: string; salary?: string; url: string; publication_date: string; description?: string }[];
    } | null;
    for (const j of data?.jobs ?? []) {
      out.push({
        id: `remotive:${j.id}`,
        source: "remotive",
        title: j.title,
        company: j.company_name,
        location: `Remote${j.candidate_required_location ? ` (${j.candidate_required_location})` : ""}`,
        salary: j.salary || undefined,
        url: j.url,
        published: ymd(j.publication_date),
        text: strip(j.description ?? "").slice(0, 500),
      });
    }
  }
  return out;
}

const WWR_FEEDS = [
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
];

export function parseRss(xml: string): { title: string; link: string; pubDate: string; region: string; description: string }[] {
  const tag = (block: string, name: string) => {
    const m = block.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
    return m ? m[1]!.trim() : "";
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: strip(tag(m[1]!, "title")),
    link: tag(m[1]!, "link"),
    pubDate: tag(m[1]!, "pubDate"),
    region: strip(tag(m[1]!, "region")),
    description: strip(tag(m[1]!, "description")),
  }));
}

export async function fetchWwr(fetchFn: FetchFn = fetch): Promise<JobCandidate[]> {
  const out: JobCandidate[] = [];
  for (const url of WWR_FEEDS) {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) continue;
    for (const it of parseRss(await res.text())) {
      // WWR sarlavhasi: "Kompaniya: Lavozim"
      const [company, ...rest] = it.title.split(":");
      out.push({
        id: `wwr:${it.link}`,
        source: "wwr",
        title: rest.length ? rest.join(":").trim() : it.title,
        company: rest.length ? company!.trim() : undefined,
        location: `Remote${it.region ? ` (${it.region})` : ""}`,
        url: it.link,
        published: ymd(it.pubDate),
        text: it.description.slice(0, 500),
      });
    }
  }
  return out;
}

/** Telegram kanalining ochiq web-ko'rinishidan oxirgi postlar (t.me/s/kanal). */
export function parseTelegramChannel(html: string, channel: string): JobCandidate[] {
  const out: JobCandidate[] = [];
  const blocks = html.split('<div class="tgme_widget_message_wrap').slice(1);
  for (const b of blocks) {
    const post = b.match(/data-post="([^"]+)"/)?.[1];
    const time = b.match(/<time datetime="([^"]+)"/)?.[1];
    const textHtml = b.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (!post || !textHtml) continue;
    const text = strip(textHtml);
    if (text.length < 40) continue;
    out.push({
      id: `tg:${post}`,
      source: "telegram",
      title: text.split("\n")[0]!.slice(0, 90),
      location: `t.me/${channel}`,
      url: `https://t.me/${post}`,
      published: time ? ymd(time) : "",
      text: text.slice(0, 700),
    });
  }
  return out;
}

export async function fetchTelegram(channels: string[], fetchFn: FetchFn = fetch): Promise<JobCandidate[]> {
  const out: JobCandidate[] = [];
  for (const raw of channels) {
    const channel = raw.replace(/^@|^https?:\/\/t\.me\/(s\/)?/g, "").replace(/\/.*$/, "").trim();
    if (!/^[A-Za-z0-9_]{4,32}$/.test(channel)) continue;
    const res = await fetchFn(`https://t.me/s/${channel}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (res?.ok) out.push(...parseTelegramChannel(await res.text(), channel));
  }
  return out;
}

/** Barcha manbalardan: yangilari (maxDays), avval chiqmaganlari, dublikatsiz. */
export async function collectJobs(opts: {
  topic: string;
  telegramChannels: string[];
  todayYmd: string;
  maxDays?: number;
  postedUrls: Set<string>;
  fetchFn?: FetchFn;
}): Promise<JobCandidate[]> {
  const f = opts.fetchFn ?? fetch;
  const queries = techKeywords(opts.topic);
  const [remotive, wwr, tg] = await Promise.all([
    queries.length ? fetchRemotive(queries, f) : Promise.resolve([]),
    fetchWwr(f),
    fetchTelegram(opts.telegramChannels, f),
  ]);
  const today = Date.parse(`${opts.todayYmd}T00:00:00Z`);
  const maxDays = opts.maxDays ?? 30;
  const seen = new Set<string>();
  return [...tg, ...remotive, ...wwr].filter((c) => {
    const age = (today - Date.parse(`${c.published}T00:00:00Z`)) / 86_400_000;
    if (!(age >= -1 && age <= maxDays)) return false;
    if (opts.postedUrls.has(c.url)) return false;
    const key = `${c.title.toLowerCase()}|${(c.company ?? "").toLowerCase()}`;
    if (seen.has(key) || seen.has(c.url)) return false;
    seen.add(key);
    seen.add(c.url);
    return true;
  });
}
