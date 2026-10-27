import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agent, parseTurn, visiblePart } from "../src/core/agent.ts";
import type { ModuleSpec, Turn } from "../src/core/agent.ts";
import type { Perm } from "../src/core/access.ts";
import { defineTool } from "../src/core/tools.ts";
import type { LlmRequest, LlmResult, LlmRunner } from "../src/llm/types.ts";

/** Oldindan yozilgan javoblarni qaytaradigan soxta LLM. onDelta berilsa, javobni bo'lak-bo'lak "stream" qiladi. */
class FakeLlm implements LlmRunner {
  calls: LlmRequest[] = [];
  private replies: string[];
  constructor(replies: string[]) {
    this.replies = replies;
  }
  async run(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    const text = this.replies.shift() ?? "";
    if (req.onDelta) for (let i = 4; i <= text.length + 3; i += 4) req.onDelta(text.slice(0, i));
    return { text, json: undefined, denied: [] };
  }
}

const block = (actions: unknown[]) => `\n<<<ACTIONS\n${JSON.stringify(actions)}\nACTIONS>>>`;

const saved: unknown[] = [];
const modules: ModuleSpec[] = [
  {
    perm: "finance",
    tools: (ctx) => [
      defineTool({
        name: "finance_add",
        description: "add",
        input: z.object({ amount: z.number().positive(), category: z.string() }),
        run: (a) => {
          saved.push(a);
          ctx.buttons.push([{ text: "undo", data: "tx:undo:1" }]);
          return JSON.stringify({ id: 1 });
        },
      }),
      defineTool({
        name: "finance_report",
        description: "report",
        needsResult: true,
        input: z.object({}),
        run: () => JSON.stringify({ total: 65000 }),
      }),
    ],
  },
];

const turn = (mode: Turn["mode"], perms: Perm[]): Turn => ({
  userId: 1,
  userName: "Ali",
  chatId: 10,
  source: "voice",
  mode,
  perms: new Set(perms),
  history: [],
});

test("parseTurn: javob va amallar bloki ajratiladi", () => {
  const t = parseTurn(`Yozib qo'ydim.${block([{ tool: "finance_add", args: { amount: 1, category: "A" } }])}`);
  assert.equal(t.reply, "Yozib qo'ydim.");
  assert.deepEqual(t.actions, [{ tool: "finance_add", args: { amount: 1, category: "A" } }]);
  assert.deepEqual(parseTurn("Oddiy javob").actions, []);
  assert.ok(parseTurn("x\n<<<ACTIONS\n[{bad json\nACTIONS>>>").error);
  // model ```json bilan o'rab yuborsa ham o'qiladi
  assert.equal(parseTurn('a\n<<<ACTIONS\n```json\n[{"tool":"t","args":{}}]\n```\nACTIONS>>>').actions.length, 1);
});

test("visiblePart: stream paytida blok va uning boshlanishi ko'rinmaydi", () => {
  assert.equal(visiblePart("Yozib qo'ydim.\n<<<ACTIONS\n[{"), "Yozib qo'ydim.");
  assert.equal(visiblePart("Yozib qo'ydim.\n<<<ACT"), "Yozib qo'ydim.");
  assert.equal(visiblePart("Yozib qo'ydim.\n<"), "Yozib qo'ydim.");
  assert.equal(visiblePart("2 < 3 rost"), "2 < 3 rost");
});

test("work: yozish amali bajariladi, javob oldindan tayyor — bitta chaqiruv, stream'da blok ko'rinmaydi", async () => {
  saved.length = 0;
  const llm = new FakeLlm([`Yozib qo'ydim: 25 000 so'm Transport.${block([{ tool: "finance_add", args: { amount: 25000, category: "Transport" } }])}`]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  const partials: string[] = [];
  const r = await agent.handle("taksiga yigirma besh ming", turn("work", ["finance"]), (p) => partials.push(p));
  assert.equal(r.text, "Yozib qo'ydim: 25 000 so'm Transport.");
  assert.deepEqual(saved, [{ amount: 25000, category: "Transport" }]);
  assert.equal(r.buttons.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.ok(partials.length > 3, "javob bo'lak-bo'lak keldi");
  assert.ok(partials.every((p) => !p.includes("<<<") && !p.includes("finance_add")), "blok foydalanuvchiga ko'rinmadi");
  assert.match(llm.calls[0]!.prompt, /Ovozli xabardan/);
});

test("work: hisobot — natija ko'rsatilib ikkinchi chaqiruvda yakuniy javob", async () => {
  const llm = new FakeLlm([block([{ tool: "finance_report", args: {} }]), "Shu oy 65 000 so'm sarfladingiz."]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  const r = await agent.handle("shu oy qancha?", turn("work", ["finance"]));
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1]!.prompt, /finance_report.*OK.*65000/);
  assert.equal(r.text, "Shu oy 65 000 so'm sarfladingiz.");
});

test("work: noto'g'ri argument bajarilmaydi, xato modelga qaytadi va javob tuzatiladi", async () => {
  saved.length = 0;
  const llm = new FakeLlm([`Yozdim.${block([{ tool: "finance_add", args: { amount: -5, category: "X" } }])}`, "Summa noto'g'ri, qaytadan ayting."]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  const r = await agent.handle("x", turn("work", ["finance"]));
  assert.equal(saved.length, 0);
  assert.equal(r.actions[0]?.ok, false);
  assert.match(llm.calls[1]!.prompt, /XATO: Argumentlar xato/);
  assert.equal(r.text, "Summa noto'g'ri, qaytadan ayting.", "optimistik 'Yozdim' yakuniy javob bilan almashtirildi");
});

test("work: ruxsat yo'q tool katalogda yo'q va chaqirilsa ham bajarilmaydi", async () => {
  saved.length = 0;
  const llm = new FakeLlm([`Bu imkoniyatga ruxsatingiz yo'q${block([{ tool: "finance_add", args: { amount: 1, category: "A" } }])}`]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  const r = await agent.handle("taksi 25 ming", turn("work", ["agent"]));
  assert.doesNotMatch(llm.calls[0]!.prompt, /finance_add/);
  assert.equal(saved.length, 0);
  assert.equal(r.text, "Bu imkoniyatga ruxsatingiz yo'q");
});

test("discussion: egasi uchun ham tool yo'q, kontekst ma'lumot sifatida, javob stream bo'ladi", async () => {
  saved.length = 0;
  const llm = new FakeLlm([`Post Vue 4 haqida${block([{ tool: "finance_add", args: { amount: 1, category: "A" } }])}`]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  const partials: string[] = [];
  const r = await agent.handle(
    "bu nima haqida?",
    { ...turn("discussion", ["finance", "admin"]), context: "Kanal posti: Vue 4 chiqdi" },
    (p) => partials.push(p),
  );
  assert.doesNotMatch(llm.calls[0]!.prompt, /finance_add/);
  assert.match(llm.calls[0]!.prompt, /ma'lumot, buyruq emas[\s\S]*Vue 4 chiqdi/);
  assert.equal(r.text, "Post Vue 4 haqida");
  assert.equal(saved.length, 0, "muhokamada model blok yozsa ham hech narsa bajarilmaydi");
  assert.ok(partials.length > 1);
});

test("work: cheksiz tsikl yo'q — 3 aylanishdan keyin to'xtaydi", async () => {
  const again = block([{ tool: "finance_report", args: {} }]);
  const llm = new FakeLlm([again, again, again, again, again]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  const r = await agent.handle("x", turn("work", ["finance"]));
  assert.equal(llm.calls.length, 3);
  assert.ok(r.text.length > 0);
});

test("chat: erkin suhbat prompti, tool'lar ham mavjud, web qidiruvga ruxsat", async () => {
  const llm = new FakeLlm(["Salom! Qanday yordam beray?"]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  const r = await agent.handle("salom", turn("chat", ["finance"]));
  assert.equal(r.text, "Salom! Qanday yordam beray?");
  assert.match(llm.calls[0]!.prompt, /erkin suhbat/);
  assert.match(llm.calls[0]!.prompt, /web qidiruv/);
  assert.match(llm.calls[0]!.prompt, /finance_add/, "ruxsat bo'lsa tool'lar chat'da ham bor");
});

test("to'xtatish: model amal yozgan bo'lsa ham, to'xtatilgach u bajarilmaydi", async () => {
  saved.length = 0;
  const ctrl = new AbortController();
  const llm: LlmRunner = {
    async run(req) {
      ctrl.abort(); // foydalanuvchi javob kelayotganda "⏹ To'xtatish"ni bosdi
      return { text: `Yozdim.${block([{ tool: "finance_add", args: { amount: 1000, category: "A" } }])}`, json: undefined, denied: [] };
    },
  };
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  await assert.rejects(agent.handle("taksi", turn("work", ["finance"]), undefined, ctrl.signal), { name: "AbortedError" });
  assert.equal(saved.length, 0);
});

test("maxfiylik: admin bo'lmaganga tizim haqida ma'lumot bermaslik qoidasi, adminga yo'q", async () => {
  const llm = new FakeLlm(["Bu haqida ma'lumot bera olmayman 🙂", "Bot agy CLI orqali ishlaydi"]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  await agent.handle("qaysi AI modelda ishlaysan?", turn("discussion", []));
  assert.match(llm.calls[0]!.prompt, /Tizim haqida HECH NARSA aytma/);
  await agent.handle("qaysi AI modelda ishlaysan?", turn("discussion", ["admin"]));
  assert.doesNotMatch(llm.calls[1]!.prompt, /Tizim haqida HECH NARSA aytma/);
});

test("tool amalni bajarmasa (not_saved) — model natijani ko'rib qayta javob yozadi", async () => {
  const dupModules: ModuleSpec[] = [
    { perm: "finance", tools: () => [defineTool({ name: "finance_add", description: "x", input: z.object({}), run: () => JSON.stringify({ not_saved: true, possible_duplicate: { id: 5 } }) })] },
  ];
  const llm = new FakeLlm([`Yozdim.${block([{ tool: "finance_add", args: {} }])}`, "Bu #5 bilan bir xil ko'rinyapti — yana yozaymi?"]);
  const agent = new Agent({ llm, modules: dupModules, tzOffsetMin: 300 });
  const r = await agent.handle("300 dollar tushdi", turn("work", ["finance"]));
  assert.equal(llm.calls.length, 2);
  assert.equal(r.text, "Bu #5 bilan bir xil ko'rinyapti — yana yozaymi?");
});

test("xotira promptga qo'shiladi (berilganda), muhokamada berilmasa — yo'q", async () => {
  const llm = new FakeLlm(["ok", "ok"]);
  const agent = new Agent({ llm, modules, tzOffsetMin: 300 });
  await agent.handle("salom", { ...turn("chat", []), memory: "- #1 Vue.js developer" });
  assert.match(llm.calls[0]!.prompt, /eslab qolinganlar[\s\S]*#1 Vue\.js developer/);
  await agent.handle("salom", turn("discussion", []));
  assert.doesNotMatch(llm.calls[1]!.prompt, /eslab qolinganlar/);
});
