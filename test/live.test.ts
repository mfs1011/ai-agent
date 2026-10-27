import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatBudget, LiveMessage, nextReveal } from "../src/bot/ui.ts";
import { parseStreamEvent } from "../src/llm/agy.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeApi() {
  const log: { op: "send" | "edit"; text: string; markup: boolean }[] = [];
  return {
    log,
    api: {
      async sendMessage(_c: number, text: string, other?: { reply_markup?: unknown }) {
        log.push({ op: "send", text, markup: !!other?.reply_markup });
        return { message_id: 7 };
      },
      async editMessageText(_c: number, _m: number, text: string, other?: { reply_markup?: unknown }) {
        log.push({ op: "edit", text, markup: !!other?.reply_markup });
        return true;
      },
    },
  };
}

const LONG =
  "Docker — bu dasturlarni barcha kerakli kutubxonalari bilan birga konteynerga joylab, istalgan serverda bir xil ishga tushirish imkonini beradigan platforma. " +
  "Konteynerlar virtual mashinalarga qaraganda ancha yengil va tez ishga tushadi. Dockerfile orqali muhit kod sifatida yoziladi.";

test("nextReveal: so'z chegarasida, qolganining ~uchdan biri, oxiri — to'liq", () => {
  const first = nextReveal(LONG, 0);
  assert.ok(first > 24 && first < LONG.length, "birdan hammasi ochilmaydi");
  assert.match(LONG[first] ?? " ", /\s/, "so'z o'rtasida kesilmaydi");
  assert.equal(nextReveal("qisqa javob", 0), "qisqa javob".length, "qisqa matn bir qadamda");
  assert.equal(nextReveal(LONG, LONG.length), LONG.length);
});

test("LiveMessage: portlab kelgan uzun javob bir necha qadamda ochiladi, oxirida kursorsiz va tugmalar bilan", async () => {
  const { api, log } = fakeApi();
  const live = new LiveMessage(api, 1, { intervalMs: 15, budget: new ChatBudget(100) });
  live.update(LONG.slice(0, 40));
  live.update(LONG); // hammasi birdan keldi (agy shunday qiladi)
  await sleep(80);
  await live.finish(LONG, [[{ text: "undo", data: "x" }]]);
  const partials = log.filter((l) => l.text.endsWith("▍") || l.text.endsWith("▌"));
  assert.ok(partials.length >= 3, `bosqichma-bosqich ochildi (${partials.length} qadam)`);
  for (let i = 1; i < partials.length; i++) assert.ok(partials[i]!.text.length > partials[i - 1]!.text.length, "har qadamda uzayadi");
  assert.equal(log.filter((l) => l.op === "send").length, 1, "hammasi bitta xabarda");
  assert.deepEqual(log[log.length - 1], { op: "edit", text: LONG, markup: true });
});

test("LiveMessage: finish matnning katta qismi ochilmagan bo'lsa ham bir-ikki qadam yozib beradi", async () => {
  const { api, log } = fakeApi();
  const live = new LiveMessage(api, 1, { intervalMs: 10, budget: new ChatBudget(100) });
  live.update(LONG.slice(0, 30));
  await live.finish(LONG);
  const texts = log.map((l) => l.text);
  assert.ok(texts.length >= 3, "birdan to'liq javob tashlanmadi");
  assert.equal(texts[texts.length - 1], LONG);
});

test("LiveMessage: stream bo'lmasa finish oddiy xabar yuboradi", async () => {
  const { api, log } = fakeApi();
  const live = new LiveMessage(api, 1);
  await live.finish("Salom");
  assert.deepEqual(log, [{ op: "send", text: "Salom", markup: false }]);
});

test("LiveMessage: o'ylash animatsiyasi nuqtalarni aylantiradi, typing yuboradi, matn kelgach to'xtaydi", async () => {
  const { api, log } = fakeApi();
  let typing = 0;
  const live = new LiveMessage({ ...api, sendChatAction: async () => void typing++ }, 1, {
    intervalMs: 15,
    thinkingMs: 15,
    budget: new ChatBudget(100),
  });
  live.startThinking("💭 O'ylayapman");
  await sleep(40);
  live.update("Javob");
  await sleep(60);
  await live.finish("Javob tayyor");
  const texts = log.map((l) => l.text);
  assert.equal(texts[0], "💭 O'ylayapman.");
  assert.ok(texts.includes("💭 O'ylayapman.."), "nuqtalar aylandi");
  assert.ok(typing >= 1, "typing indikatori yuborildi");
  const firstAnswer = texts.findIndex((t) => t.startsWith("Javob"));
  assert.ok(firstAnswer > 0);
  assert.ok(texts.slice(firstAnswer).every((t) => !t.startsWith("💭")), "matn kelgandan keyin animatsiya chiqmadi");
  assert.equal(texts[texts.length - 1], "Javob tayyor");
  assert.equal(log.filter((l) => l.op === "send").length, 1, "hammasi bitta xabarda");
});

test("ChatBudget: limitdan oshgan animatsiya kadrlari o'tkaziladi, yakuniy javob doim o'tadi", async () => {
  const budget = new ChatBudget(3, 60_000);
  assert.equal(budget.take(1), true);
  assert.equal(budget.take(1), true);
  assert.equal(budget.take(1), true);
  assert.equal(budget.take(1), false, "4-kadr o'tkaziladi");
  assert.equal(budget.take(2), true, "boshqa chat alohida hisoblanadi");
  assert.equal(budget.take(1, true), true, "yakuniy xabar doim yuboriladi");

  const { api, log } = fakeApi();
  const live = new LiveMessage(api, 1, { intervalMs: 10, thinkingMs: 10, budget });
  live.startThinking("💭");
  await sleep(40);
  live.update(LONG);
  await sleep(40);
  await live.finish(LONG);
  assert.equal(log[log.length - 1]!.text, LONG, "limit to'lgan bo'lsa ham javob yetib bordi");
  assert.ok(log.length <= 2, "animatsiya kadrlari limitni oshirmadi");
});

test("parseStreamEvent: matn bo'lagi va yakuniy natija", () => {
  assert.deepEqual(
    parseStreamEvent('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Sa"}}'),
    { delta: "Sa" },
  );
  assert.deepEqual(parseStreamEvent('{"event":"result","result":{"status":"SUCCESS","response":"Salom"}}'), {
    result: { status: "SUCCESS", response: "Salom" },
  });
  assert.equal(parseStreamEvent('{"event":"step_update","step_update":{"step_type":"user_input"}}'), null);
  assert.equal(parseStreamEvent("jetski: warning"), null);
});

test("LiveMessage: jarayon davomida '⏹ To'xtatish' tugmasi, yakunda olib tashlanadi", async () => {
  const { api, log } = fakeApi();
  const live = new LiveMessage(api, 1, { intervalMs: 10, thinkingMs: 10, budget: new ChatBudget(100), controls: [[{ text: "⏹", data: "stop:1" }]] });
  live.startThinking("💭");
  await sleep(15);
  await live.finish("Tayyor");
  assert.equal(log[0]!.markup, true, "o'ylash paytida tugma bor");
  assert.deepEqual(log[log.length - 1], { op: "edit", text: "Tayyor", markup: false });
});

test("LiveMessage rich: o'ylash premium emoji bilan, javob rich, rad etilsa — HTML'ga o'tadi", async () => {
  const calls: { op: string; body: unknown }[] = [];
  let rejectRich = false;
  const api = {
    async sendMessage(_c: number, text: string, other?: { parse_mode?: string }) {
      calls.push({ op: `send:${other?.parse_mode ?? "plain"}`, body: text });
      return { message_id: 7 };
    },
    async sendRichMessage(_c: number, rich: { markdown: string }) {
      if (rejectRich) throw new Error("Bad Request: rich");
      calls.push({ op: "sendRich", body: rich.markdown });
      return { message_id: 7 };
    },
    async editMessageText(_c: number, _m: number, body: string | { markdown: string }, other?: { parse_mode?: string }) {
      if (typeof body !== "string" && rejectRich) throw new Error("Bad Request: rich");
      calls.push({ op: typeof body === "string" ? `edit:${other?.parse_mode ?? "plain"}` : "editRich", body: typeof body === "string" ? body : body.markdown });
      return true;
    },
  };
  const live = new LiveMessage(api, 1, { intervalMs: 10, thinkingMs: 10, budget: new ChatBudget(100), rich: true });
  live.startThinking("💭 O'ylayapman");
  await sleep(5);
  await live.finish("**Javob** ==muhim==");
  assert.equal(calls[0]!.op, "sendRich");
  assert.match(String(calls[0]!.body), /^!\[💭\]\(tg:\/\/emoji\?id=\d+\) O'ylayapman\./, "premium o'ylash emojisi");
  assert.deepEqual(calls.at(-1), { op: "editRich", body: "**Javob** ==muhim==" });

  calls.length = 0;
  rejectRich = true;
  const live2 = new LiveMessage(api, 1, { intervalMs: 10, budget: new ChatBudget(100), rich: true });
  await live2.finish("**Javob**");
  assert.deepEqual(calls, [{ op: "send:HTML", body: "<b>Javob</b>" }], "rich rad etildi — HTML");
});
