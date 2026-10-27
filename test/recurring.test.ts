import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { addTransaction, recentTransactions } from "../src/modules/finance/repo.ts";
import {
  addRecurring,
  deleteRecurring,
  dueDay,
  dueToday,
  forecastMonth,
  listRecurring,
  markPaid,
  markSkipped,
  paymentStatus,
  updateRecurring,
} from "../src/modules/finance/recurring.ts";
import { formatForecast, recurringButtons } from "../src/modules/finance/jobs.ts";

const U = 1;
const NOW = new Date("2026-10-10T05:00:00Z"); // Toshkent: 10-oktabr 10:00 (31 kunlik oy)

function setup() {
  const db = openDb(":memory:");
  const rent = addRecurring(db, { userId: U, kind: "expense", name: "Ijara", amount: 3_000_000, currency: "UZS", category: "Uy-joy", day: 5 });
  const net = addRecurring(db, { userId: U, kind: "expense", name: "Internet", amount: 150_000, currency: "UZS", category: "Aloqa va internet", day: 20 });
  const salary = addRecurring(db, { userId: U, kind: "income", name: "Maosh", amount: 8_000_000, currency: "UZS", category: "Maosh", day: 25 });
  return { db, rent, net, salary };
}

test("dueDay: 31-sana qisqa oyda oxirgi kunga tushadi", () => {
  assert.equal(dueDay(31, 2026, 2), 28);
  assert.equal(dueDay(31, 2026, 10), 31);
  assert.equal(dueDay(5, 2026, 2), 5);
});

test("markPaid: tranzaksiya yoziladi, ikkinchi bosish hech narsa qilmaydi", () => {
  const { db, rent } = setup();
  const r1 = markPaid(db, U, rent.id, "2026-10", "2026-10-05");
  assert.equal(r1.ok, true);
  assert.equal(markPaid(db, U, rent.id, "2026-10", "2026-10-05").ok, false);
  assert.equal(recentTransactions(db, U).length, 1);
  assert.equal(recentTransactions(db, U)[0]?.note, "Ijara");
  assert.equal(paymentStatus(db, rent.id, "2026-10"), "paid");
  assert.equal(paymentStatus(db, rent.id, "2026-11"), "due", "keyingi oy yana kutiladi");
  assert.equal(markSkipped(db, U, rent.id, "2026-10"), false, "to'langanini o'tkazib bo'lmaydi");
});

test("boshqa foydalanuvchi to'lovini belgilay olmaydi", () => {
  const { db, rent } = setup();
  assert.equal(markPaid(db, 999, rent.id, "2026-10", "2026-10-05").ok, false);
});

test("prognoz: sarflangan + to'lanmagan majburiy + o'zgaruvchan o'rtacha × qolgan kunlar", () => {
  const { db, rent } = setup();
  markPaid(db, U, rent.id, "2026-10", "2026-10-05"); // 3 000 000 majburiy
  addTransaction(db, { userId: U, kind: "expense", amount: 500_000, currency: "UZS", category: "Oziq-ovqat", occurredOn: "2026-10-08", source: "text" });
  const f = forecastMonth(db, U, NOW, 300, "UZS", null);
  assert.equal(f.spent, 3_500_000);
  assert.equal(f.dailyVariable, 50_000, "500 000 / 10 kun — ijara o'zgaruvchanga kirmaydi");
  assert.equal(f.daysLeft, 21);
  assert.equal(f.dueExpense, 150_000, "internet hali to'lanmagan");
  assert.equal(f.expectedExpense, 3_500_000 + 150_000 + 50_000 * 21);
  assert.equal(f.expectedIncome, 8_000_000, "maosh kutilmoqda");
  assert.equal(f.expectedBalance, 8_000_000 - f.expectedExpense);
  assert.equal(f.nextMonthExpense, 3_150_000 + 50_000 * 30, "noyabr 30 kun");
  const text = formatForecast(f);
  assert.match(text, /✅ 05-sana · \*\*Ijara\*\*/);
  assert.match(text, /⏳ 20-sana · \*\*Internet\*\*/);
});

test("prognoz: to'xtatilgan to'lov hisobga olinmaydi; o'chirish ishlaydi", () => {
  const { db, net, salary } = setup();
  updateRecurring(db, U, net.id, { active: 0 });
  assert.equal(listRecurring(db, U).length, 2);
  assert.equal(forecastMonth(db, U, NOW, 300, "UZS", null).dueExpense, 3_000_000, "faqat ijara (to'lanmagan); internet to'xtatilgan");
  deleteRecurring(db, U, salary.id);
  assert.equal(forecastMonth(db, U, NOW, 300, "UZS", null).expectedIncome, 0);
});

test("dueToday: bugungi va belgilanmagan to'lovlar", () => {
  const { db, net } = setup();
  const day20 = new Date("2026-10-20T04:00:00Z");
  assert.deepEqual(dueToday(db, day20, 300).map((r) => r.name), ["Internet"]);
  markSkipped(db, U, net.id, "2026-10");
  assert.equal(dueToday(db, day20, 300).length, 0);
});

test("eslatma tugmasi yashil va to'g'ri callback", () => {
  const { net } = setup();
  const [[paid, skip]] = recurringButtons(net, "2026-10") as unknown as [[{ data: string; style?: string }, { data: string }]];
  assert.equal(paid.data, `rc:paid:${net.id}:2026-10`);
  assert.equal(paid.style, "success");
  assert.equal(skip.data, `rc:skip:${net.id}:2026-10`);
});

test("oddiy yozuv majburiy to'lovga avtomatik bog'lanadi va prognoz ikki marta hisoblamaydi", async () => {
  const { linkRecurringPayment } = await import("../src/modules/finance/recurring.ts");
  const { deleteTransaction } = await import("../src/modules/finance/repo.ts");
  const { db, salary, net } = setup();
  const tx = addTransaction(db, { userId: U, kind: "income", amount: 8_000_000, currency: "UZS", category: "Maosh", occurredOn: "2026-10-10", source: "text" });
  assert.equal(linkRecurringPayment(db, U, tx, "maosh tushdi")?.name, "Maosh");
  const f = forecastMonth(db, U, NOW, 300, "UZS", null);
  assert.equal(f.expectedIncome, 8_000_000, "16 mln emas");
  assert.equal(paymentStatus(db, salary.id, "2026-10"), "paid");

  // ↩️ bekor qilinsa — yana kutilmoqda
  deleteTransaction(db, U, tx.id);
  assert.equal(paymentStatus(db, salary.id, "2026-10"), "due");

  // mos kelmaydigan: oziq-ovqat 150 000 internetga bog'lanmaydi (kategoriya ham, nom ham boshqa)
  const food = addTransaction(db, { userId: U, kind: "expense", amount: 150_000, currency: "UZS", category: "Oziq-ovqat", occurredOn: "2026-10-10", source: "text" });
  assert.equal(linkRecurringPayment(db, U, food, "bozordan xarid"), null);
  assert.equal(paymentStatus(db, net.id, "2026-10"), "due");
  // nom tilga olinsa — kategoriya boshqa bo'lsa ham bog'lanadi
  const n = addTransaction(db, { userId: U, kind: "expense", amount: 150_000, currency: "UZS", category: "Boshqa", occurredOn: "2026-10-10", source: "text" });
  assert.equal(linkRecurringPayment(db, U, n, "internetga 150 ming to'ladim")?.name, "Internet");
});
