import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineMd, mdToHtml, mdToPlain } from "../src/bot/format.ts";

test("inline: qalin, kursiv, kod, havola, chizilgan, spoiler", () => {
  assert.equal(inlineMd("**Jami:** 25 000 so'm"), "<b>Jami:</b> 25 000 so'm");
  assert.equal(inlineMd("bu *muhim* gap"), "bu <i>muhim</i> gap");
  assert.equal(inlineMd("`npm run check` ishlat"), "<code>npm run check</code> ishlat");
  assert.equal(inlineMd("[nodejs](https://nodejs.org)"), '<a href="https://nodejs.org">nodejs</a>');
  assert.equal(inlineMd("~~eski~~ yangi"), "<s>eski</s> yangi");
  assert.equal(inlineMd("||sir||"), "<tg-spoiler>sir</tg-spoiler>");
});

test("inline: HTML belgilar escape qilinadi, kod ichida formatlash yo'q", () => {
  assert.equal(inlineMd("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  assert.equal(inlineMd("`<div>**x**</div>`"), "<code>&lt;div&gt;**x**&lt;/div&gt;</code>");
  assert.equal(inlineMd("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("inline: so'z ichidagi belgilarga tegmaydi", () => {
  assert.equal(inlineMd("finance_add va user_id"), "finance_add va user_id");
  assert.equal(inlineMd("2*3*4 = 24"), "2*3*4 = 24");
  assert.equal(inlineMd("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(inlineMd("[x](javascript:alert(1))"), "[x](javascript:alert(1))", "faqat http(s) havola");
});

test("blok: sarlavha, ro'yxat, iqtibos, chiziq", () => {
  const html = mdToHtml("## Hisobot\n- Transport: **59 000**\n  - taksi\n1. birinchi\n> Maslahat: kamroq sarfla\n---\nOxiri");
  assert.equal(
    html,
    "<b>Hisobot</b>\n• Transport: <b>59 000</b>\n   ◦ taksi\n1. birinchi\n<blockquote>Maslahat: kamroq sarfla</blockquote>\n──────────\nOxiri",
  );
});

test("blok: kod bloki tilli, ichi escape", () => {
  assert.equal(mdToHtml("```ts\nconst a = 1 < 2;\n```"), '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
});

test("blok: jadval monospace'ga aylanadi", () => {
  const html = mdToHtml("| Nom | Narx |\n|---|---|\n| **Taksi** | 25 000 |\n| Osh | 40 000 |");
  assert.equal(html, "<pre>Nom    Narx\nTaksi  25 000\nOsh    40 000</pre>");
});

test("stream: yarim kelgan matn baribir to'g'ri HTML", () => {
  assert.equal(mdToHtml("**Jami:** 25 000\n**Kate"), "<b>Jami:</b> 25 000\nKate");
  assert.equal(mdToHtml("Kod:\n```js\nconsole.log(1"), 'Kod:\n<pre><code class="language-js">console.log(1</code></pre>');
  for (const partial of ["**a", "*a", "`a", "[a](http", "> q", "| a | b", "~~x", "||s"]) {
    const html = mdToHtml(partial);
    const opens = (html.match(/<(b|i|s|u|code|pre|a|blockquote|tg-spoiler)[ >]/g) ?? []).length;
    const closes = (html.match(/<\/(b|i|s|u|code|pre|a|blockquote|tg-spoiler)>/g) ?? []).length;
    assert.equal(opens, closes, `teglar muvozanatda: ${partial} -> ${html}`);
  }
});

test("mdToPlain: zaxira ko'rinish", () => {
  assert.equal(mdToPlain("## Sarlavha\n**qalin** `kod` [n](https://x.uz)"), "Sarlavha\nqalin kod n (https://x.uz)");
});
