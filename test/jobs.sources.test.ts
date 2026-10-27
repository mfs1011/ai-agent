import { test } from "node:test";
import assert from "node:assert/strict";
import { collectJobs, parseRss, parseTelegramChannel, techKeywords } from "../src/modules/feeds/job-sources.ts";
import { composeJobsPost, isJobsFeed, postedUrls } from "../src/modules/feeds/index.ts";

const TG_HTML = `
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="uzjobs/101">
<div class="tgme_widget_message_text js-message_text" dir="auto">💼 Senior Vue.js Developer<br/>Kompaniya: Uzum<br/>Maosh: $3000. Vue 3, Nuxt, TypeScript, 4+ yil tajriba. Toshkent, gibrid.</div>
<time datetime="2026-10-25T09:00:00+00:00" class="time">09:00</time></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="uzjobs/102">
<div class="tgme_widget_message_text js-message_text">qisqa</div><time datetime="2026-10-26T09:00:00+00:00"></time></div></div>`;

const RSS = `<rss><channel>
<item><title>Acme Corp: Senior Laravel Developer</title><link>https://weworkremotely.com/remote-jobs/acme-senior-laravel</link>
<pubDate>Fri, 24 Oct 2026 10:00:00 +0000</pubDate><region>Anywhere in the World</region><description><![CDATA[<p>Laravel &amp; Vue</p>]]></description></item>
<item><title>Old Co: PHP Dev</title><link>https://weworkremotely.com/remote-jobs/old</link><pubDate>Mon, 01 Jun 2026 10:00:00 +0000</pubDate><region>USA Only</region><description>x</description></item>
</channel></rss>`;

test("parseTelegramChannel: post havolasi, sana, matn; juda qisqa postlar tashlanadi", () => {
  const jobs = parseTelegramChannel(TG_HTML, "uzjobs");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.url, "https://t.me/uzjobs/101");
  assert.equal(jobs[0]!.published, "2026-10-25");
  assert.match(jobs[0]!.text, /Kompaniya: Uzum/);
});

test("parseRss: WWR elementlari", () => {
  const items = parseRss(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, "Acme Corp: Senior Laravel Developer");
  assert.equal(items[0]!.description, "Laravel & Vue");
});

test("techKeywords va isJobsFeed", () => {
  assert.deepEqual(techKeywords("Remote yoki Toshkentdagi Vue, Nuxt, Node.js, Laravel vakansiyalari"), ["vue", "nuxt", "node", "laravel"]);
  assert.equal(isJobsFeed("Vue, Laravel vakansiyalari"), true);
  assert.equal(isJobsFeed("web dasturlash yangiliklari"), false);
});

test("collectJobs: eski va avval chiqqanlar tashlanadi, barcha manbalar birlashadi", async () => {
  const fetchFn = (async (url: string) => {
    if (url.includes("remotive")) {
      return new Response(JSON.stringify({ jobs: [{ id: 1, title: "Vue Dev", company_name: "R", candidate_required_location: "Worldwide", url: "https://remotive.com/j/1", publication_date: "2026-10-20T00:00:00", description: "<b>Vue</b>" }] }));
    }
    if (url.includes("weworkremotely")) return new Response(RSS);
    if (url.includes("t.me/s/uzjobs")) return new Response(TG_HTML);
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const jobs = await collectJobs({
    topic: "Vue vakansiyalari",
    telegramChannels: ["@uzjobs"],
    todayYmd: "2026-10-27",
    postedUrls: new Set(["https://remotive.com/j/1"]),
    fetchFn,
  });
  const urls = jobs.map((j) => j.url);
  assert.ok(urls.includes("https://t.me/uzjobs/101"));
  assert.ok(urls.includes("https://weworkremotely.com/remote-jobs/acme-senior-laravel"));
  assert.ok(!urls.includes("https://remotive.com/j/1"), "avval chiqqan");
  assert.ok(!urls.includes("https://weworkremotely.com/remote-jobs/old"), "eski (iyun)");
  assert.equal(new Set(urls).size, urls.length, "dublikatsiz (3 ta WWR lentasi bir xil e'lonni qaytaradi)");
});

test("composeJobsPost: model havola/kompaniya/sanani o'zgartira olmaydi, noma'lum id tashlanadi", async () => {
  const candidates = [
    { id: "wwr:1", source: "wwr" as const, title: "Senior Laravel Developer", company: "Acme", location: "Remote", url: "https://weworkremotely.com/x", published: "2026-10-24", text: "Laravel" },
  ];
  const llm = {
    async run() {
      return {
        text: "",
        json: {
          title: "Vakansiyalar",
          picks: [
            { id: "wwr:1", title: "Boshqa nom", summary: "Laravel bo'yicha senior.", stack: ["Laravel"], company: "Soxta", salary: "$9999" },
            { id: "uydirma:9", title: "Uydirma", summary: "x" },
          ],
        },
        denied: [],
      };
    },
  };
  const post = await composeJobsPost(llm, { id: 1, channel_id: 1, topic: "laravel", hour: 9, enabled: 1, last_run_on: null }, candidates);
  assert.equal(post!.items.length, 1);
  const it = post!.items[0]!;
  assert.equal(it.url, "https://weworkremotely.com/x");
  assert.equal(it.title, "Senior Laravel Developer", "nom manbadan");
  assert.equal(it.company, "Acme", "kompaniya manbadan");
  assert.equal(it.salary, undefined, "rasmiy manbada maosh yo'q — model qo'sha olmaydi");
});

test("postedUrls: avvalgi postlardagi havolalar", () => {
  assert.deepEqual([...postedUrls(["1️⃣ **[A](https://a.uz/1)**\n2️⃣ **[B](https://b.uz/2)**"])], ["https://a.uz/1", "https://b.uz/2"]);
});
