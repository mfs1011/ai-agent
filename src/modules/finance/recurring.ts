import type { Db } from "../../db.ts";
import { nowIso } from "../../db.ts";
import { localDate } from "../../core/time.ts";
import type { Kind } from "./repo.ts";
import { addTransaction, report, toBase } from "./repo.ts";
import type { Rates } from "./rates.ts";

// Oylik majburiy to'lovlar (ijara, internet, kredit...) va muntazam daromadlar (maosh).
// Har oy uchun holat: to'landi / o'tkazildi / kutilmoqda. Prognoz shular asosida.

export type Recurring = {
  id: number;
  kind: Kind;
  name: string;
  amount: number;
  currency: string;
  category: string;
  day: number;
  active: number;
};

const COLS = "id, kind, name, amount, currency, category, day, active";

export function addRecurring(
  db: Db,
  r: { userId: number; kind: Kind; name: string; amount: number; currency: string; category: string; day: number },
): Recurring {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO recurring (user_id, kind, name, amount, currency, category, day, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
    )
    .get(r.userId, r.kind, r.name, r.amount, r.currency, r.category, r.day, now, now) as Recurring;
}

export function getRecurring(db: Db, userId: number, id: number): Recurring | null {
  return (db.prepare(`SELECT ${COLS} FROM recurring WHERE id = ? AND user_id = ?`).get(id, userId) as Recurring | undefined) ?? null;
}

export function listRecurring(db: Db, userId: number, includeInactive = false): Recurring[] {
  return db
    .prepare(`SELECT ${COLS} FROM recurring WHERE user_id = ? ${includeInactive ? "" : "AND active = 1"} ORDER BY day, id`)
    .all(userId) as Recurring[];
}

export function updateRecurring(
  db: Db,
  userId: number,
  id: number,
  patch: Partial<Pick<Recurring, "kind" | "name" | "amount" | "currency" | "category" | "day" | "active">>,
): Recurring | null {
  const cur = getRecurring(db, userId, id);
  if (!cur) return null;
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Recurring;
  db.prepare(
    "UPDATE recurring SET kind = ?, name = ?, amount = ?, currency = ?, category = ?, day = ?, active = ?, updated_at = ? WHERE id = ? AND user_id = ?",
  ).run(next.kind, next.name, next.amount, next.currency, next.category, next.day, next.active, nowIso(), id, userId);
  return getRecurring(db, userId, id);
}

export function deleteRecurring(db: Db, userId: number, id: number): boolean {
  db.prepare("DELETE FROM recurring_payments WHERE recurring_id IN (SELECT id FROM recurring WHERE id = ? AND user_id = ?)").run(id, userId);
  return db.prepare("DELETE FROM recurring WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

export type PaymentStatus = "paid" | "skipped" | "due";

/** To'lov holati. Bog'langan yozuv o'chirilgan (↩️ bekor qilingan) bo'lsa — yana "due". */
export function paymentStatus(db: Db, recurringId: number, month: string): PaymentStatus {
  const row = db
    .prepare(
      `SELECT p.status FROM recurring_payments p LEFT JOIN transactions t ON t.id = p.transaction_id
       WHERE p.recurring_id = ? AND p.month = ? AND (p.status = 'skipped' OR t.deleted_at IS NULL)`,
    )
    .get(recurringId, month) as { status: PaymentStatus } | undefined;
  return row?.status ?? "due";
}

/**
 * Oddiy yozilgan xarajat/daromad majburiy to'lovga mos kelsa — shu oy uchun "to'landi" deb bog'laydi.
 * Mos: tur va valyuta bir xil, shu oy kutilmoqda, summa ±10%, va (kategoriya bir xil yoki matnda nomi bor).
 * Shunda prognoz ikki marta hisoblamaydi. Bog'langan to'lov nomi yoki null.
 */
export function linkRecurringPayment(
  db: Db,
  userId: number,
  tx: { id: number; kind: Kind; amount: number; currency: string; category: string; occurred_on: string; note?: string | null },
  rawText = "",
): Recurring | null {
  const month = tx.occurred_on.slice(0, 7);
  const text = `${rawText} ${tx.note ?? ""}`.toLowerCase();
  const candidates = listRecurring(db, userId)
    .filter((r) => r.kind === tx.kind && r.currency === tx.currency)
    .filter((r) => Math.abs(r.amount - tx.amount) <= r.amount * 0.1)
    .filter((r) => r.category === tx.category || text.includes(r.name.toLowerCase()))
    .filter((r) => paymentStatus(db, r.id, month) === "due")
    .sort((a, b) => Math.abs(a.amount - tx.amount) - Math.abs(b.amount - tx.amount));
  const r = candidates[0];
  if (!r) return null;
  db.prepare(
    "INSERT OR REPLACE INTO recurring_payments (recurring_id, month, status, transaction_id, created_at) VALUES (?, ?, 'paid', ?, ?)",
  ).run(r.id, month, tx.id, nowIso());
  return r;
}

/** "To'landi": tranzaksiya yoziladi va oy uchun belgilanadi. Ikki marta bosilsa — ikkinchisi hech narsa qilmaydi. */
export function markPaid(db: Db, userId: number, id: number, month: string, onDate: string): { ok: boolean; transactionId?: number } {
  const r = getRecurring(db, userId, id);
  if (!r || paymentStatus(db, id, month) !== "due") return { ok: false };
  const tx = addTransaction(db, {
    userId,
    kind: r.kind,
    amount: r.amount,
    currency: r.currency,
    category: r.category,
    note: r.name,
    occurredOn: onDate,
    source: "text",
  });
  db.prepare("INSERT OR REPLACE INTO recurring_payments (recurring_id, month, status, transaction_id, created_at) VALUES (?, ?, 'paid', ?, ?)").run(
    id,
    month,
    tx.id,
    nowIso(),
  );
  return { ok: true, transactionId: tx.id };
}

export function markSkipped(db: Db, userId: number, id: number, month: string): boolean {
  if (!getRecurring(db, userId, id) || paymentStatus(db, id, month) !== "due") return false;
  db.prepare("INSERT OR REPLACE INTO recurring_payments (recurring_id, month, status, transaction_id, created_at) VALUES (?, ?, 'skipped', NULL, ?)").run(id, month, nowIso());
  return true;
}

/** To'lov kuni shu oyda (31-sana 30 kunlik oyda — 30-sana). */
export function dueDay(day: number, year: number, month1: number): number {
  return Math.min(day, new Date(Date.UTC(year, month1, 0)).getUTCDate());
}

/** Bugun to'lanishi kerak bo'lgan va hali belgilanmagan to'lovlar (barcha foydalanuvchilar) — eslatma uchun. */
export function dueToday(db: Db, now: Date, tzOffsetMin: number): (Recurring & { user_id: number })[] {
  const today = localDate(now, tzOffsetMin);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const month = today.slice(0, 7);
  const rows = db.prepare(`SELECT ${COLS}, user_id FROM recurring WHERE active = 1`).all() as (Recurring & { user_id: number })[];
  return rows.filter((r) => dueDay(r.day, y, m) === d && paymentStatus(db, r.id, month) === "due");
}

export type ForecastItem = Recurring & { dueOn: string; status: PaymentStatus; amountBase: number };

export type Forecast = {
  month: string;
  daysInMonth: number;
  daysLeft: number;
  currency: string;
  /** Shu paytgacha (asosiy valyutada) */
  spent: number;
  received: number;
  /** Majburiy to'lovlarsiz kundalik o'rtacha xarajat */
  dailyVariable: number;
  /** Hali to'lanmagan majburiy to'lovlar / kutilayotgan muntazam daromadlar */
  dueExpense: number;
  dueIncome: number;
  /** Oy oxirigacha prognoz */
  expectedExpense: number;
  expectedIncome: number;
  expectedBalance: number;
  /** Kelasi oy: majburiy + o'rtacha o'zgaruvchan */
  nextMonthExpense: number;
  nextMonthIncome: number;
  items: ForecastItem[];
};

/**
 * Prognoz: oy oxirigacha = sarflangan + to'lanmagan majburiy + (kundalik o'zgaruvchan o'rtacha × qolgan kunlar).
 * O'zgaruvchan xarajat = jami xarajat − majburiy to'lovlardan yozilganlar.
 */
export function forecastMonth(db: Db, userId: number, now: Date, tzOffsetMin: number, currency: string, fx: Rates | null): Forecast {
  const today = localDate(now, tzOffsetMin);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const month = today.slice(0, 7);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cur = fx?.rates ?? null;
  // Yozuvlar — o'z kunidagi kurs bilan; majburiy to'lovlar summasi (kelajakdagi) — joriy kurs bilan
  const amountToBase = (amount: number, ccy: string) =>
    toBase({ currency: ccy, rated_uzs: ccy === "UZS" ? amount : 0, unrated: ccy === "UZS" ? 0 : amount }, cur, currency) ?? 0;

  const rep = report(db, userId, `${month}-01`, today);
  const spent = rep.totals.filter((t) => t.kind === "expense").reduce((a, t) => a + (toBase(t, cur, currency) ?? 0), 0);
  const received = rep.totals.filter((t) => t.kind === "income").reduce((a, t) => a + (toBase(t, cur, currency) ?? 0), 0);

  const items: ForecastItem[] = listRecurring(db, userId).map((r) => ({
    ...r,
    dueOn: `${month}-${String(dueDay(r.day, y, m)).padStart(2, "0")}`,
    status: paymentStatus(db, r.id, month),
    amountBase: amountToBase(r.amount, r.currency),
  }));

  // Shu oy majburiy to'lov sifatida yozilgan xarajatlar — o'zgaruvchan o'rtachaga kirmasin
  const paidRecurring = (
    db
      .prepare(
        `SELECT t.amount, t.currency, t.rate_uzs FROM recurring_payments p JOIN transactions t ON t.id = p.transaction_id
         JOIN recurring r ON r.id = p.recurring_id
         WHERE p.month = ? AND p.status = 'paid' AND r.user_id = ? AND r.kind = 'expense' AND t.deleted_at IS NULL`,
      )
      .all(month, userId) as { amount: number; currency: string; rate_uzs: number | null }[]
  ).reduce(
    (a, t) =>
      a +
      (toBase({ currency: t.currency, rated_uzs: t.rate_uzs ? t.amount * t.rate_uzs : 0, unrated: t.rate_uzs ? 0 : t.amount }, cur, currency) ?? 0),
    0,
  );

  const dailyVariable = Math.max(0, spent - paidRecurring) / Math.max(1, d);
  const daysLeft = daysInMonth - d;
  const due = (kind: Kind) => items.filter((i) => i.kind === kind && i.status === "due").reduce((a, i) => a + i.amountBase, 0);
  const all = (kind: Kind) => items.filter((i) => i.kind === kind).reduce((a, i) => a + i.amountBase, 0);
  const dueExpense = due("expense");
  const dueIncome = due("income");
  const expectedExpense = spent + dueExpense + dailyVariable * daysLeft;
  const expectedIncome = received + dueIncome;

  return {
    month,
    daysInMonth,
    daysLeft,
    currency,
    spent,
    received,
    dailyVariable,
    dueExpense,
    dueIncome,
    expectedExpense,
    expectedIncome,
    expectedBalance: expectedIncome - expectedExpense,
    nextMonthExpense: all("expense") + dailyVariable * daysNext,
    nextMonthIncome: all("income"),
    items,
  };
}
