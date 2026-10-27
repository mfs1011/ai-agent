import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import {
  addTransaction,
  deleteTransaction,
  formatAmount,
  recentTransactions,
  report,
  updateTransaction,
} from "../src/modules/finance/repo.ts";

const USER = 1;

function seed() {
  const db = openDb(":memory:");
  const base = { userId: USER, currency: "UZS", source: "text" as const };
  addTransaction(db, { ...base, kind: "expense", amount: 25000, category: "Transport", occurredOn: "2026-10-27" });
  addTransaction(db, { ...base, kind: "expense", amount: 40000, category: "Oziq-ovqat", occurredOn: "2026-10-27" });
  addTransaction(db, { ...base, kind: "expense", amount: 15000, category: "Transport", occurredOn: "2026-10-20" });
  addTransaction(db, { ...base, kind: "income", amount: 8_000_000, category: "Maosh", occurredOn: "2026-10-05" });
  addTransaction(db, { ...base, kind: "expense", amount: 99000, category: "Kiyim", occurredOn: "2026-09-30" });
  return db;
}

test("report: davr bo'yicha jami va kategoriyalar", () => {
  const db = seed();
  const r = report(db, USER, "2026-10-01", "2026-10-31");
  const expense = r.totals.find((t) => t.kind === "expense");
  assert.equal(expense?.total, 80000);
  assert.equal(expense?.count, 3);
  assert.equal(r.totals.find((t) => t.kind === "income")?.total, 8_000_000);
  const transport = r.byCategory.find((c) => c.category === "Transport");
  assert.equal(transport?.total, 40000);
});

test("delete: soft delete hisobotga kirmaydi, qayta o'chirib bo'lmaydi", () => {
  const db = seed();
  const [last] = recentTransactions(db, USER, 1);
  assert.ok(last);
  assert.equal(deleteTransaction(db, USER, last.id), true);
  assert.equal(deleteTransaction(db, USER, last.id), false);
  assert.equal(recentTransactions(db, USER, 10).some((t) => t.id === last.id), false);
});

test("update: faqat berilgan maydonlar o'zgaradi", () => {
  const db = seed();
  const updated = updateTransaction(db, USER, 1, { amount: 30000 });
  assert.equal(updated?.amount, 30000);
  assert.equal(updated?.category, "Transport");
});

test("boshqa foydalanuvchi yozuviga tegib bo'lmaydi", () => {
  const db = seed();
  assert.equal(deleteTransaction(db, 999, 1), false);
  assert.equal(updateTransaction(db, 999, 1, { amount: 1 }), null);
});

test("noto'g'ri summa rad etiladi", () => {
  const db = openDb(":memory:");
  assert.throws(() =>
    addTransaction(db, {
      userId: USER,
      kind: "expense",
      amount: 0,
      currency: "UZS",
      category: "Boshqa",
      occurredOn: "2026-10-27",
      source: "text",
    }),
  );
});

test("formatAmount", () => {
  assert.equal(formatAmount(25000, "UZS"), "25 000 so'm");
  assert.equal(formatAmount(12.5, "USD"), "12,5 USD");
});

test("oylik hisobot: jami, kategoriyalar, kunlar va o'tgan oy bilan solishtirish", async () => {
  const { buildMonthReport, reportSvg, reportCaption, renderPng } = await import("../src/modules/finance/report-image.ts");
  const db = seed(); // 27-oktabr holati: 80 000 xarajat (3 ta), 8 000 000 daromad; 30-sentabr 99 000
  const r = buildMonthReport(db, USER, new Date("2026-10-27T09:00:00Z"), 300, "UZS");
  assert.equal(r.expense, 80000);
  assert.equal(r.income, 8_000_000);
  assert.equal(r.title, "Oktabr 2026");
  assert.equal(r.days.length, 27);
  assert.equal(r.days.find((d) => d.day === "2026-10-27")?.total, 65000);
  assert.equal(r.categories[0]?.category, "Oziq-ovqat");
  assert.equal(r.prevExpense, 0, "30-sentabr o'tgan oyning 1–27 oralig'iga kirmaydi");

  const svg = reportSvg(r);
  assert.match(svg, /80 000/);
  assert.match(svg, /Kategoriyalar/);
  assert.doesNotMatch(svg, /undefined|NaN/);
  const caption = reportCaption(r);
  assert.match(caption, /<b>80 000 so'm<\/b>/);
  assert.match(caption, /🛒 Oziq-ovqat/);
  const png = renderPng(svg);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
});

test("bo'sh oy: rasm xatosiz chiqadi", async () => {
  const { buildMonthReport, reportSvg, renderPng } = await import("../src/modules/finance/report-image.ts");
  const db = openDb(":memory:");
  const r = buildMonthReport(db, USER, new Date("2026-11-01T09:00:00Z"), 300, "UZS");
  assert.equal(r.expense, 0);
  const svg = reportSvg(r);
  assert.match(svg, /xarajat yozilmagan/);
  assert.doesNotMatch(svg, /undefined|NaN|Infinity/);
  assert.ok(renderPng(svg).length > 1000);
});

test("finance_add: undo yozuvni o'chiradi; oylik hisobotga rasm qo'shiladi", async () => {
  const { financeTools } = await import("../src/modules/finance/tools.ts");
  const db = openDb(":memory:");
  const ctx = { userId: USER, chatId: 1, source: "voice" as const, rawText: "x", buttons: [], photos: [], undo: [] as (() => void)[] };
  const tools = financeTools(db, { tzOffsetMin: 300, defaultCurrency: "UZS" })(ctx);
  await tools.find((t) => t.name === "finance_add")!.run({ kind: "expense", amount: 95000, category: "Transport" });
  assert.equal(recentTransactions(db, USER).length, 1);
  ctx.undo.forEach((f) => f());
  assert.equal(recentTransactions(db, USER).length, 0, "tuzatishda oldingi yozuv bekor qilindi");

  await tools.find((t) => t.name === "finance_report")!.run({});
  assert.equal(ctx.photos.length, 1);
  await tools.find((t) => t.name === "finance_report")!.run({ period: "week" });
  assert.equal(ctx.photos.length, 1, "haftalik hisobotga oylik rasm qo'shilmaydi");
});

test("hisobot: USD daromad kurs bo'yicha so'mga o'giriladi va jamiga qo'shiladi", async () => {
  const { buildMonthReport, reportCaption, reportSvg } = await import("../src/modules/finance/report-image.ts");
  const db = openDb(":memory:");
  const base = { userId: USER, source: "text" as const, occurredOn: "2026-10-27" };
  addTransaction(db, { ...base, kind: "expense", amount: 96500, currency: "UZS", category: "Transport" });
  addTransaction(db, { ...base, kind: "income", amount: 300, currency: "USD", category: "Freelance" });
  addTransaction(db, { ...base, kind: "expense", amount: 10, currency: "XYZ", category: "Boshqa" });
  const fx = { date: "27.10.2026", fetchedAt: Date.now(), rates: { UZS: 1, USD: 12000 } };
  const r = buildMonthReport(db, USER, new Date("2026-10-27T09:00:00Z"), 300, "UZS", fx);
  assert.equal(r.income, 3_600_000);
  assert.equal(r.expense, 96500, "kursi yo'q valyuta jamiga qo'shilmaydi");
  assert.deepEqual(r.otherCurrencies.map((o) => o.currency), ["XYZ"]);
  assert.match(r.rateNote ?? "", /1 USD ≈ 12 000 so'm · CBU, yozuv kunidagi kurs/);
  const caption = reportCaption(r);
  assert.match(caption, /Daromad: <b>3 600 000 so'm<\/b> \(300 USD\)/);
  assert.match(caption, /Kurs topilmadi/);
  assert.match(reportSvg(r), /shu jumladan 300 USD/);
});

test("hisobot: kurs bo'lmasa ham ishlaydi (valyuta alohida ko'rsatiladi)", async () => {
  const { buildMonthReport } = await import("../src/modules/finance/report-image.ts");
  const db = openDb(":memory:");
  addTransaction(db, { userId: USER, source: "text", occurredOn: "2026-10-27", kind: "income", amount: 300, currency: "USD", category: "Freelance" });
  const r = buildMonthReport(db, USER, new Date("2026-10-27T09:00:00Z"), 300, "UZS", null);
  assert.equal(r.income, 0);
  assert.equal(r.otherCurrencies[0]?.currency, "USD");
});

test("RateProvider: CBU javobi o'qiladi, keshlanadi, internet bo'lmasa keshdan", async () => {
  const { RateProvider, parseCbu } = await import("../src/modules/finance/rates.ts");
  const { Settings } = await import("../src/core/state.ts");
  const rows = [{ Ccy: "USD", Rate: "11861.96", Nominal: "1", Date: "27.10.2026" }, { Ccy: "JPY", Rate: "7800", Nominal: "100", Date: "27.10.2026" }];
  assert.equal(parseCbu(rows).rates.JPY, 78, "Nominal hisobga olinadi");
  const settings = new Settings(openDb(":memory:"));
  let calls = 0;
  const ok = new RateProvider(settings, (async () => (calls++, new Response(JSON.stringify(rows)))) as unknown as typeof fetch);
  assert.equal((await ok.get())?.rates.USD, 11861.96);
  await ok.get();
  assert.equal(calls, 1, "kesh ishlatildi");
  const offline = new RateProvider(settings, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
  settings.set("fx_rates", JSON.stringify({ ...JSON.parse(settings.get("fx_rates")), fetchedAt: 0 }));
  assert.equal((await offline.get())?.rates.USD, 11861.96, "internet yo'q — eski kurs");
});

test("toBase: yozuv kunidagi kurs saqlangan qism + kursi yo'q qism joriy kurs bilan", async () => {
  const { toBase } = await import("../src/modules/finance/repo.ts");
  const cur = { UZS: 1, USD: 12000 };
  assert.equal(toBase({ currency: "USD", rated_uzs: 300 * 11800, unrated: 0 }, cur, "UZS"), 3_540_000, "saqlangan kurs ishlatiladi");
  assert.equal(toBase({ currency: "USD", rated_uzs: 0, unrated: 100 }, cur, "UZS"), 1_200_000, "kursi yo'q — joriy");
  assert.equal(toBase({ currency: "XYZ", rated_uzs: 0, unrated: 5 }, cur, "UZS"), null);
  assert.equal(toBase({ currency: "UZS", rated_uzs: 50000, unrated: 0 }, null, "UZS"), 50000);
});

test("hisobot: valyuta yozuvi to'lov kunidagi kurs bilan, joriy kurs bilan emas", async () => {
  const { buildMonthReport } = await import("../src/modules/finance/report-image.ts");
  const { setTransactionRate } = await import("../src/modules/finance/repo.ts");
  const db = openDb(":memory:");
  const tx = addTransaction(db, { userId: USER, source: "text", occurredOn: "2026-10-01", kind: "income", amount: 300, currency: "USD", category: "Freelance" });
  setTransactionRate(db, tx.id, 11808.76); // 1-oktabr kursi
  const fx = { date: "27.10.2026", fetchedAt: Date.now(), rates: { UZS: 1, USD: 11861.96 } };
  const r = buildMonthReport(db, USER, new Date("2026-10-27T09:00:00Z"), 300, "UZS", fx);
  assert.equal(Math.round(r.income), Math.round(300 * 11808.76));
  assert.match(r.rateNote ?? "", /1 USD ≈ 11 809 so'm/);
});

test("findDuplicate: 2 soat ichidagi bir xil yozuv yoki aynan shu gap — dublikat", async () => {
  const { findDuplicate } = await import("../src/modules/finance/repo.ts");
  const db = openDb(":memory:");
  const base = { userId: USER, kind: "income" as const, amount: 300, currency: "USD", occurredOn: "2026-10-27" };
  addTransaction(db, { ...base, category: "Freelance", source: "voice", rawText: "Frilansdan 300 dollar tushdi" });
  assert.ok(findDuplicate(db, { ...base, rawText: "boshqa gap" }), "summa/sana/valyuta bir xil, yaqinda");
  assert.equal(findDuplicate(db, { ...base, amount: 500 }), null);
  assert.equal(findDuplicate(db, { ...base, kind: "expense" }), null);
  assert.equal(findDuplicate(db, { ...base, occurredOn: "2026-10-26" }), null, "boshqa kun");
});

test("finance_add: dublikat yozilmaydi, force bilan yoziladi; valyutaga o'sha kun kursi saqlanadi", async () => {
  const { financeTools } = await import("../src/modules/finance/tools.ts");
  const db = openDb(":memory:");
  const rates = { forDate: async () => ({ UZS: 1, USD: 11808.76 }), get: async () => null } as never;
  const ctx = { userId: USER, chatId: 1, source: "voice" as const, rawText: "300 dollar tushdi", buttons: [], photos: [], undo: [] as (() => void)[] };
  const add = financeTools(db, { tzOffsetMin: 300, defaultCurrency: "UZS", rates })(ctx).find((t) => t.name === "finance_add")!;
  const args = { kind: "income", amount: 300, currency: "USD", category: "Freelance" };
  JSON.parse(await add.run(args));
  const second = JSON.parse(await add.run(args));
  assert.equal(second.not_saved, true);
  assert.equal(recentTransactions(db, USER).length, 1);
  await add.run({ ...args, force: true });
  assert.equal(recentTransactions(db, USER).length, 2);
  const row = db.prepare("SELECT rate_uzs FROM transactions ORDER BY id LIMIT 1").get() as { rate_uzs: number };
  assert.equal(row.rate_uzs, 11808.76);
});
