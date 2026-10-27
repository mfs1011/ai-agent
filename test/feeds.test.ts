import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLinks } from "../src/modules/feeds/index.ts";

const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

test("checkLinks: qidiruv sahifalari rad etiladi, aniq sahifalar o'tadi", async () => {
  const md =
    "[a](https://hh.uz/search/vacancy?text=Laravel) [b](https://vuejobs.com/jobs) [c](https://hh.uz/vacancy/123456) " +
    "[d](https://google.com/?q=vue) [e](https://blog.vuejs.org/posts/vue-3-6)";
  const res = await checkLinks(md, ok);
  const byUrl = Object.fromEntries(res.map((r) => [r.url, r.ok]));
  assert.equal(byUrl["https://hh.uz/search/vacancy?text=Laravel"], false);
  assert.equal(byUrl["https://vuejobs.com/jobs"], false, "ro'yxat sahifasi");
  assert.equal(byUrl["https://google.com/?q=vue"], false);
  assert.equal(byUrl["https://hh.uz/vacancy/123456"], true);
  assert.equal(byUrl["https://blog.vuejs.org/posts/vue-3-6"], true);
});

test("checkLinks: aniq kompaniyaning vakansiyalar sahifasi qabul qilinadi, bosh sahifa yo'q", async () => {
  const res = await checkLinks("[a](https://career.habr.com/companies/clevercraft/vacancies) [b](https://hh.uz/)", ok);
  assert.deepEqual(res.map((r) => r.ok), [true, false]);
});

test("checkLinks: ochilmaydigan sahifa rad etiladi, 403 (bot bloki) qabul qilinadi", async () => {
  const fetchFn = (async (url: string) =>
    new Response("", { status: url.includes("gone") ? 404 : 403 })) as unknown as typeof fetch;
  const res = await checkLinks("[x](https://a.uz/gone) [y](https://b.uz/post/1)", fetchFn);
  assert.deepEqual(
    res.map((r) => [r.ok, r.reason]),
    [
      [false, "HTTP 404"],
      [true, undefined],
    ],
  );
});

test("renderFeedPost (yangiliklar): ixcham shablon, teg qatori sarlavha bo'lmaydi, markdown buzilmaydi", async () => {
  const { renderFeedPost } = await import("../src/modules/feeds/post.ts");
  const md = renderFeedPost(
    {
      kind: "news",
      emoji: "🌐",
      title: "Web dasturlash",
      intro: "Bugun: Nuxt 4.5 va Symfony 8.2",
      items: [
        { title: "Nuxt 4.5 chiqdi", url: "https://nuxt.com/blog/v4-5", published: "2026-10-25", summary: "SSR **streaming** va `useLayout`.\nTezroq build." },
        { title: "Symfony [8.2]", url: "https://symfony.com/blog/8-2", published: "2026-10-25", summary: "Messenger Inbox" },
      ],
      hashtags: ["#Nuxt", "Symfony", "Web Dev"],
    },
    "27-oktabr",
  );
  assert.equal(
    md,
    "🌐 **Web dasturlash**\n_27-oktabr · Nuxt 4.5 va Symfony 8.2_\n\n" +
      "1️⃣ **[Nuxt 4.5 chiqdi](https://nuxt.com/blog/v4-5)**\nSSR streaming va useLayout. Tezroq build.\n\n" +
      "2️⃣ **[Symfony 8.2](https://symfony.com/blog/8-2)**\nMessenger Inbox\n\n" +
      "🏷 #Nuxt #Symfony #WebDev",
  );
  assert.ok(!md.split("\n").some((l) => l.startsWith("#")), "hech bir qator # bilan boshlanmaydi");
});

test("renderFeedPost (vakansiya): kompaniya, joy, maosh marker bilan, stek", async () => {
  const { renderFeedPost } = await import("../src/modules/feeds/post.ts");
  const md = renderFeedPost(
    {
      kind: "jobs",
      emoji: "💼",
      title: "Vakansiyalar",
      intro: "",
      items: [
        { title: "Senior Vue Developer", url: "https://x.uz/j/1", published: "2026-10-20", summary: "5+ yil.", company: "Clever Craft", location: "Remote", salary: "$3 400 – 4 100", stack: ["Vue 3", "Nuxt"] },
        { title: "Laravel Dev", url: "https://x.uz/j/2", published: "2026-10-20", summary: "PHP.", company: "Wiregate" },
      ],
      hashtags: ["vakansiya"],
    },
    "27-oktabr",
  );
  assert.match(md, /1️⃣ \*\*\[Senior Vue Developer\]\(https:\/\/x\.uz\/j\/1\)\*\*\n🏢 Clever Craft {2}· {2}📍 Remote\n💰 ==\$3 400 – 4 100==\n🧩 `Vue 3` `Nuxt`\n5\+ yil\./);
  assert.doesNotMatch(md.split("2️⃣")[1]!, /💰/, "maosh yo'q bo'lsa — yozilmaydi");
});

test("keepVerifiedItems: shubhali havolali band olib tashlanadi, qolgani saqlanadi", async () => {
  const { keepVerifiedItems } = await import("../src/modules/feeds/index.ts");
  const post = {
    kind: "news" as const,
    emoji: "🌐",
    title: "t",
    intro: "",
    hashtags: [],
    items: [
      { title: "a", url: "https://hh.uz/search/vacancy?text=vue", summary: "", published: "2026-10-25" },
      { title: "b", url: "https://nuxt.com/blog/v4", summary: "", published: "2026-10-25" },
    ],
  };
  const { post: kept, dropped } = await keepVerifiedItems(post, ok);
  assert.deepEqual(kept.items.map((i) => i.title), ["b"]);
  assert.equal(dropped.length, 1);
});

test("keepFreshItems: yangilik 14 kun, vakansiya 30 kun; sanasiz yoki eski — olib tashlanadi", async () => {
  const { keepFreshItems } = await import("../src/modules/feeds/post.ts");
  const item = (title: string, published: string) => ({ title, url: "https://a.uz/x", summary: "", published });
  const base = { emoji: "", title: "", intro: "", hashtags: [] };
  const news = keepFreshItems({ ...base, kind: "news", items: [item("yangi", "2026-10-20"), item("eski", "2024-10-21"), item("sanasiz", "")] }, "2026-10-27");
  assert.deepEqual(news.post.items.map((i) => i.title), ["yangi"]);
  assert.deepEqual(news.stale.map((i) => i.title), ["eski", "sanasiz"]);
  const jobs = keepFreshItems({ ...base, kind: "jobs", items: [item("25 kun", "2026-10-02"), item("40 kun", "2026-09-17")] }, "2026-10-27");
  assert.deepEqual(jobs.post.items.map((i) => i.title), ["25 kun"]);
});

test("repairLinks: 404 havola qidirib tiklanadi, tasdiqlanmagani tashlanadi", async () => {
  const { repairLinks } = await import("../src/modules/feeds/index.ts");
  const llm = {
    async run() {
      return {
        text: "",
        json: { fixes: [{ index: 0, url: "https://symfony.com/blog/new-in-symfony-8-2-jsonschema-real" }, { index: 1, url: "https://x.uz/gone" }] },
        denied: [],
      };
    },
  };
  const fetchFn = (async (url: string) => new Response("", { status: url.includes("gone") ? 404 : 200 })) as unknown as typeof fetch;
  const items = [
    { title: "JsonSchema", url: "https://symfony.com/blog/guess-1", summary: "", published: "2026-10-25" },
    { title: "Boshqa", url: "https://x.uz/guess-2", summary: "", published: "2026-10-25" },
  ];
  const fixed = await repairLinks(llm, items, fetchFn);
  assert.deepEqual([...fixed.entries()], [["https://symfony.com/blog/guess-1", "https://symfony.com/blog/new-in-symfony-8-2-jsonschema-real"]]);
});

test("composePost: yaroqsiz javobdan keyin bir marta qayta so'raladi; sanasiz band ham qabul qilinadi (keyin filtrlanadi)", async () => {
  const { composePost } = await import("../src/modules/feeds/index.ts");
  let calls = 0;
  const llm = {
    async run() {
      calls++;
      if (calls === 1) return { text: "", json: { nonsense: true }, denied: [] };
      return { text: "", json: { kind: "news", title: "Web", items: [{ title: "Vue 3.6", url: "https://blog.vuejs.org/x" }] }, denied: [] };
    },
  };
  const post = await composePost(llm, { id: 1, channel_id: 1, topic: "vue", hour: 9, enabled: 1, last_run_on: null }, 300, []);
  assert.equal(calls, 2);
  assert.equal(post?.items[0]?.published, "", "sanasiz — keyin keepFreshItems tashlaydi");
  assert.equal(post?.emoji, "📰");
});
