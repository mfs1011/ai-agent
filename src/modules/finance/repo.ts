import type { Db } from "../../db.ts";
import { nowIso } from "../../db.ts";

export const EXPENSE_CATEGORIES = [
  "Oziq-ovqat",
  "Kafe va restoran",
  "Transport",
  "Uy-joy",
  "Kommunal",
  "Aloqa va internet",
  "Sog'liq",
  "Kiyim",
  "Ta'lim",
  "Ko'ngilochar",
  "Sovg'alar",
  "Boshqa",
] as const;

export const INCOME_CATEGORIES = ["Maosh", "Freelance", "Sovg'a", "Boshqa"] as const;

export type Kind = "expense" | "income";

export type Transaction = {
  id: number;
  kind: Kind;
  amount: number;
  currency: string;
  category: string;
  note: string | null;
  occurred_on: string;
  source: string;
};

export type NewTransaction = {
  userId: number;
  kind: Kind;
  amount: number;
  currency: string;
  category: string;
  note?: string | null;
  occurredOn: string;
  source: "text" | "voice";
  rawText?: string | null;
};

const COLS = "id, kind, amount, currency, category, note, occurred_on, source";

export function addTransaction(db: Db, t: NewTransaction): Transaction {
  if (!(t.amount > 0) || !Number.isFinite(t.amount)) throw new Error("Summa musbat son bo'lishi kerak");
  const row = db
    .prepare(
      `INSERT INTO transactions (user_id, kind, amount, currency, category, note, occurred_on, source, raw_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
    )
    .get(t.userId, t.kind, t.amount, t.currency, t.category, t.note ?? null, t.occurredOn, t.source, t.rawText ?? null, nowIso());
  if (t.currency === "UZS") db.prepare("UPDATE transactions SET rate_uzs = 1 WHERE id = ?").run((row as Transaction).id);
  return row as Transaction;
}

export function getTransaction(db: Db, userId: number, id: number): Transaction | null {
  const row = db
    .prepare(`SELECT ${COLS} FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(id, userId);
  return (row as Transaction | undefined) ?? null;
}

export function updateTransaction(
  db: Db,
  userId: number,
  id: number,
  patch: Partial<Pick<Transaction, "kind" | "amount" | "currency" | "category" | "note" | "occurred_on">>,
): Transaction | null {
  const current = getTransaction(db, userId, id);
  if (!current) return null;
  const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  if (!(next.amount > 0)) throw new Error("Summa musbat son bo'lishi kerak");
  db.prepare(
    "UPDATE transactions SET kind = ?, amount = ?, currency = ?, category = ?, note = ?, occurred_on = ? WHERE id = ? AND user_id = ?",
  ).run(next.kind, next.amount, next.currency, next.category, next.note, next.occurred_on, id, userId);
  return getTransaction(db, userId, id);
}

/** Soft delete: yozuv o'chirilgan deb belgilanadi (undo xavfsiz bo'lsin). */
export function deleteTransaction(db: Db, userId: number, id: number): boolean {
  const res = db
    .prepare("UPDATE transactions SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(nowIso(), id, userId);
  return res.changes > 0;
}

export function recentTransactions(db: Db, userId: number, limit = 10): Transaction[] {
  return db
    .prepare(`SELECT ${COLS} FROM transactions WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`)
    .all(userId, limit) as Transaction[];
}

/**
 * Summalar valyuta bo'yicha. rated_uzs — kursi ma'lum qismi so'mda (yozuv kunidagi kurs bilan),
 * unrated — kursi hali olinmagan qismi (asl valyutada; joriy kurs bilan o'giriladi).
 */
export type MoneyRow = { kind: Kind; currency: string; total: number; count: number; rated_uzs: number; unrated: number };

export type Report = {
  from: string;
  to: string;
  totals: MoneyRow[];
  byCategory: (MoneyRow & { category: string })[];
};

const RATED = `SUM(amount * COALESCE(rate_uzs, CASE WHEN currency = 'UZS' THEN 1 END)) AS rated_uzs,
  SUM(CASE WHEN rate_uzs IS NULL AND currency <> 'UZS' THEN amount ELSE 0 END) AS unrated`;

/**
 * Asosiy valyutaga o'girish: kursi saqlangan qism — yozuv kunidagi kurs bilan, qolgani — joriy kurs bilan.
 * Joriy kurs ham yo'q bo'lsa — null (o'girib bo'lmaydi).
 */
export function toBase(row: Pick<MoneyRow, "currency" | "rated_uzs" | "unrated">, current: Record<string, number> | null, base: string): number | null {
  let uzs = row.rated_uzs ?? 0;
  if (row.unrated > 0) {
    const r = current?.[row.currency];
    if (!r) return null;
    uzs += row.unrated * r;
  }
  if (base === "UZS") return uzs;
  const b = current?.[base];
  return b ? uzs / b : null;
}

export function setTransactionRate(db: Db, id: number, rateUzs: number) {
  db.prepare("UPDATE transactions SET rate_uzs = ? WHERE id = ?").run(rateUzs, id);
}

/** Kursi hali olinmagan valyuta yozuvlari (fon rejimida to'ldiriladi). */
export function unratedTransactions(db: Db, limit = 200): { id: number; currency: string; occurred_on: string }[] {
  return db
    .prepare("SELECT id, currency, occurred_on FROM transactions WHERE rate_uzs IS NULL AND currency <> 'UZS' AND deleted_at IS NULL LIMIT ?")
    .all(limit) as { id: number; currency: string; occurred_on: string }[];
}

/**
 * Ehtimoliy dublikat: oxirgi 2 soatda shu tur/valyuta/sana va deyarli shu summa (±0.5%),
 * yoki 24 soat ichida aynan shu gap (ovoz qayta yuborilganda).
 */
export function findDuplicate(
  db: Db,
  t: { userId: number; kind: Kind; amount: number; currency: string; occurredOn: string; rawText?: string | null },
): Transaction | null {
  const since2h = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const byAmount = db
    .prepare(
      `SELECT ${COLS} FROM transactions WHERE user_id = ? AND kind = ? AND currency = ? AND occurred_on = ?
       AND deleted_at IS NULL AND created_at >= ? AND ABS(amount - ?) <= ? * 0.005 ORDER BY id DESC LIMIT 1`,
    )
    .get(t.userId, t.kind, t.currency, t.occurredOn, since2h, t.amount, t.amount) as Transaction | undefined;
  if (byAmount) return byAmount;
  const norm = (t.rawText ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (norm.length < 6) return null;
  const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const recent = db
    .prepare(`SELECT ${COLS}, raw_text FROM transactions WHERE user_id = ? AND kind = ? AND deleted_at IS NULL AND created_at >= ? AND raw_text IS NOT NULL`)
    .all(t.userId, t.kind, since24h) as (Transaction & { raw_text: string })[];
  return recent.find((r) => r.raw_text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === norm && Math.abs(r.amount - t.amount) <= t.amount * 0.005) ?? null;
}

export function report(db: Db, userId: number, from: string, to: string): Report {
  const where = "user_id = ? AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ?";
  const totals = db
    .prepare(`SELECT kind, currency, SUM(amount) AS total, COUNT(*) AS count, ${RATED} FROM transactions WHERE ${where} GROUP BY kind, currency`)
    .all(userId, from, to) as Report["totals"];
  const byCategory = db
    .prepare(
      `SELECT kind, currency, category, SUM(amount) AS total, COUNT(*) AS count, ${RATED} FROM transactions WHERE ${where}
       GROUP BY kind, currency, category ORDER BY total DESC`,
    )
    .all(userId, from, to) as Report["byCategory"];
  return { from, to, totals, byCategory };
}

/** STT lug'ati uchun: foydalanuvchi ishlatgan kategoriyalar va izohlardagi so'zlar. */
export function knownTerms(db: Db, userId: number): string[] {
  const rows = db
    .prepare("SELECT DISTINCT category FROM transactions WHERE user_id = ? AND deleted_at IS NULL LIMIT 50")
    .all(userId) as { category: string }[];
  return rows.map((r) => r.category);
}

export function formatAmount(amount: number, currency: string): string {
  const s = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(amount).replace(/ /g, " ");
  return currency === "UZS" ? `${s} so'm` : `${s} ${currency}`;
}

/** Kunlar bo'yicha jami (bir valyuta va tur uchun): YYYY-MM-DD -> summa. */
export function dailyTotals(db: Db, userId: number, kind: Kind, currency: string, from: string, to: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT occurred_on AS day, SUM(amount) AS total FROM transactions
       WHERE user_id = ? AND kind = ? AND currency = ? AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ?
       GROUP BY occurred_on`,
    )
    .all(userId, kind, currency, from, to) as { day: string; total: number }[];
  return new Map(rows.map((r) => [r.day, r.total]));
}

/** Kunlar bo'yicha jami, barcha valyutalar: [{day, currency, total}]. */
export function dailyTotalsAll(
  db: Db,
  userId: number,
  kind: Kind,
  from: string,
  to: string,
): { day: string; currency: string; total: number; rated_uzs: number; unrated: number }[] {
  return db
    .prepare(
      `SELECT occurred_on AS day, currency, SUM(amount) AS total, ${RATED} FROM transactions
       WHERE user_id = ? AND kind = ? AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ?
       GROUP BY occurred_on, currency`,
    )
    .all(userId, kind, from, to) as { day: string; currency: string; total: number; rated_uzs: number; unrated: number }[];
}
