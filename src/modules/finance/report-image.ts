import { Resvg } from "@resvg/resvg-js";
import type { Db } from "../../db.ts";
import { localDate } from "../../core/time.ts";
import { dailyTotalsAll, formatAmount, report, toBase } from "./repo.ts";
import type { Rates } from "./rates.ts";
import type { Forecast } from "./recurring.ts";
import { forecastMonth } from "./recurring.ts";

// Moliya hisoboti rasm (PNG) + qisqa HTML matn. LLM'siz — raqamlar to'g'ridan DB'dan.
// Shakl: hero raqam (jami xarajat), kategoriyalar — gorizontal bar, kunlar — ustunlar. Bitta qator ma'lumot — bitta rang.

const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

// Qorong'i yuza (dataviz palitrasi, validator bilan tekshirilgan: #3987e5 — dark surface'da hamma tekshiruvdan o'tadi)
const C = {
  surface: "#1a1a19",
  card: "#232322",
  primary: "#f0efec",
  secondary: "#c3c2b7",
  muted: "#8a897f",
  grid: "#2e2e2c",
  series: "#3987e5",
  good: "#3fa34d",
  bad: "#e66767",
};
const FONT = "Inter, 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif";

export const CATEGORY_EMOJI: Record<string, string> = {
  "Oziq-ovqat": "🛒",
  "Kafe va restoran": "🍽",
  Transport: "🚕",
  "Uy-joy": "🏠",
  Kommunal: "💡",
  "Aloqa va internet": "📶",
  "Sog'liq": "💊",
  Kiyim: "👕",
  "Ta'lim": "📚",
  "Ko'ngilochar": "🎬",
  "Sovg'alar": "🎁",
  Maosh: "💼",
  Freelance: "💻",
  Boshqa: "📦",
};

export type MonthReport = {
  title: string;
  rangeLabel: string;
  currency: string;
  expense: number;
  income: number;
  prevExpense: number;
  categories: { category: string; total: number; count: number }[];
  days: { day: string; total: number }[];
  /** Kurs bo'yicha so'mga o'girilgan boshqa valyutadagi summalar (asl ko'rinishda ko'rsatish uchun). */
  foreign: { kind: string; currency: string; total: number }[];
  /** Kurs topilmagan valyutalar — jamiga qo'shilmagan. */
  otherCurrencies: { kind: string; currency: string; total: number }[];
  /** Masalan "1 USD = 11 862 so'm · CBU 27.10.2026". */
  rateNote: string | null;
  forecast: Forecast;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n).replace(/ /g, " ");

/**
 * "Shu oy" hisobot ma'lumotlari: oy boshidan bugungacha va o'tgan oyning shu kunigacha bo'lgan qism (solishtirish uchun).
 * Boshqa valyutalar (masalan USD) kurs bo'yicha asosiy valyutaga o'giriladi va jamiga qo'shiladi.
 */
export function buildMonthReport(
  db: Db,
  userId: number,
  now: Date,
  tzOffsetMin: number,
  currency: string,
  fx: Rates | null = null,
): MonthReport {
  const today = localDate(now, tzOffsetMin);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const from = `${today.slice(0, 7)}-01`;
  const prevFrom = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const prevLastDay = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const prevTo = `${prevFrom.slice(0, 8)}${String(Math.min(d, prevLastDay)).padStart(2, "0")}`;

  // Asosiy valyutaga o'girish: har yozuv o'z kunidagi kurs bilan (saqlangan), qolgani — joriy kurs bilan
  const cur = fx?.rates ?? null;
  const conv = (row: Parameters<typeof toBase>[0]) => toBase(row, cur, currency);

  const r = report(db, userId, from, today);
  const prev = report(db, userId, prevFrom, prevTo);
  const sum = (rep: typeof r, kind: string) => rep.totals.filter((t) => t.kind === kind).reduce((a, t) => a + (conv(t) ?? 0), 0);

  const byCat = new Map<string, { category: string; total: number; count: number }>();
  for (const c of r.byCategory.filter((c) => c.kind === "expense")) {
    const v = conv(c);
    if (v === null) continue;
    const e = byCat.get(c.category) ?? { category: c.category, total: 0, count: 0 };
    e.total += v;
    e.count += c.count;
    byCat.set(c.category, e);
  }

  const daily = new Map<string, number>();
  for (const row of dailyTotalsAll(db, userId, "expense", from, today)) {
    const v = toBase({ ...row }, cur, currency);
    if (v !== null) daily.set(row.day, (daily.get(row.day) ?? 0) + v);
  }
  const days = Array.from({ length: d }, (_, i) => {
    const day = `${today.slice(0, 8)}${String(i + 1).padStart(2, "0")}`;
    return { day, total: daily.get(day) ?? 0 };
  });

  const foreign = r.totals.filter((t) => t.currency !== currency && conv(t) !== null);
  const usedRates = [...new Set(foreign.map((t) => t.currency))]
    .map((c) => {
      const rows = foreign.filter((t) => t.currency === c);
      const amount = rows.reduce((a, t) => a + t.total, 0);
      const value = rows.reduce((a, t) => a + (conv(t) ?? 0), 0);
      return `1 ${c} ≈ ${fmt(value / amount)} ${currency === "UZS" ? "so'm" : currency}`;
    })
    .join(", ");

  return {
    title: `${MONTHS[m - 1]![0]!.toUpperCase()}${MONTHS[m - 1]!.slice(1)} ${y}`,
    rangeLabel: `1–${d} ${MONTHS[m - 1]}`,
    currency,
    expense: sum(r, "expense"),
    income: sum(r, "income"),
    prevExpense: sum(prev, "expense"),
    categories: [...byCat.values()].sort((a, b) => b.total - a.total),
    days,
    foreign,
    otherCurrencies: r.totals.filter((t) => t.currency !== currency && conv(t) === null),
    rateNote: usedRates ? `${usedRates} · CBU, yozuv kunidagi kurs` : null,
    forecast: forecastMonth(db, userId, now, tzOffsetMin, currency, fx),
  };
}

/** "300 USD" kabi asl summalar (kind bo'yicha). */
function foreignLine(r: MonthReport, kind: string): string | null {
  const list = r.foreign.filter((f) => f.kind === kind);
  return list.length ? list.map((f) => formatAmount(f.total, f.currency)).join(" + ") : null;
}

function changeLabel(cur: number, prev: number): { text: string; color: string } | null {
  if (prev <= 0) return null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { text: "o'tgan oy bilan bir xil", color: C.secondary };
  // Xarajat oshsa — yomon (qizil), kamaysa — yaxshi (yashil). Rang yolg'iz emas: belgi va so'z ham bor.
  return pct > 0
    ? { text: `▲ ${pct}% o'tgan oyning shu davriga nisbatan`, color: C.bad }
    : { text: `▼ ${-pct}% o'tgan oyning shu davriga nisbatan`, color: C.good };
}

export function reportSvg(r: MonthReport): string {
  const W = 1080;
  const P = 64;
  const cats = r.categories.slice(0, 8);
  const rest = r.categories.slice(8);
  if (rest.length) cats.push({ category: "Boshqalar", total: rest.reduce((a, c) => a + c.total, 0), count: rest.reduce((a, c) => a + c.count, 0) });

  const parts: string[] = [];
  let y = P;

  // Sarlavha
  parts.push(`<text x="${P}" y="${y + 30}" font-size="30" fill="${C.secondary}">${esc(r.title)} · xarajatlar</text>`);
  parts.push(`<text x="${W - P}" y="${y + 30}" font-size="26" fill="${C.muted}" text-anchor="end">${esc(r.rangeLabel)}</text>`);
  y += 60;

  // Hero raqam
  const unit = r.currency === "UZS" ? "so'm" : r.currency;
  parts.push(
    `<text x="${P}" y="${y + 92}" font-size="104" font-weight="700" fill="${C.primary}">${fmt(r.expense)}<tspan font-size="44" font-weight="500" fill="${C.secondary}" dx="16">${esc(unit)}</tspan></text>`,
  );
  y += 124;
  const change = changeLabel(r.expense, r.prevExpense);
  if (change) {
    parts.push(`<text x="${P}" y="${y + 24}" font-size="26" fill="${change.color}">${esc(change.text)}</text>`);
    y += 44;
  }

  // Kichik kartochkalar: daromad, balans
  y += 20;
  const cardW = (W - 2 * P - 24) / 2;
  const balance = r.income - r.expense;
  const incomeForeign = foreignLine(r, "income");
  const chips: [string, string, string, string | null][] = [
    ["Daromad", `${fmt(r.income)} ${unit}`, C.primary, incomeForeign ? `shu jumladan ${incomeForeign}` : null],
    ["Balans", `${balance < 0 ? "−" : ""}${fmt(Math.abs(balance))} ${unit}`, balance < 0 ? C.bad : C.good, null],
  ];
  const chipH = chips.some((c) => c[3]) ? 146 : 112;
  chips.forEach(([label, value, color, sub], i) => {
    const x = P + i * (cardW + 24);
    parts.push(`<rect x="${x}" y="${y}" width="${cardW}" height="${chipH}" rx="20" fill="${C.card}"/>`);
    parts.push(`<text x="${x + 28}" y="${y + 42}" font-size="24" fill="${C.muted}">${label}</text>`);
    parts.push(`<text x="${x + 28}" y="${y + 86}" font-size="36" font-weight="600" fill="${color}">${esc(value)}</text>`);
    if (sub) parts.push(`<text x="${x + 28}" y="${y + 124}" font-size="22" fill="${C.secondary}">${esc(sub)}</text>`);
  });
  y += chipH + 24;

  // Prognoz kartochkasi: oy oxirigacha taxmin
  const f = r.forecast;
  if (f.daysLeft > 0 || f.items.length) {
    const fh = f.dueExpense > 0 ? 150 : 116;
    parts.push(`<rect x="${P}" y="${y}" width="${W - 2 * P}" height="${fh}" rx="20" fill="${C.card}"/>`);
    parts.push(`<rect x="${P}" y="${y}" width="6" height="${fh}" rx="3" fill="${C.series}"/>`);
    parts.push(`<text x="${P + 32}" y="${y + 42}" font-size="24" fill="${C.muted}">Oy oxirigacha prognoz · ${f.daysLeft} kun qoldi</text>`);
    parts.push(
      `<text x="${P + 32}" y="${y + 88}" font-size="32" font-weight="600" fill="${C.primary}">~${fmt(f.expectedExpense)} <tspan font-size="26" font-weight="400" fill="${C.secondary}">xarajat · qoladi </tspan><tspan fill="${f.expectedBalance < 0 ? C.bad : C.good}">${f.expectedBalance < 0 ? "−" : ""}${fmt(Math.abs(f.expectedBalance))}</tspan></text>`,
    );
    if (f.dueExpense > 0) {
      const n = f.items.filter((i) => i.kind === "expense" && i.status === "due").length;
      parts.push(`<text x="${P + 32}" y="${y + 128}" font-size="24" fill="${C.secondary}">shu jumladan ${n} ta to'lanmagan majburiy to'lov: ${fmt(f.dueExpense)}</text>`);
    }
    y += fh;
  }
  y += 56;

  // Kategoriyalar — gorizontal bar'lar, to'g'ridan yozilgan qiymat
  parts.push(`<text x="${P}" y="${y}" font-size="30" font-weight="600" fill="${C.primary}">Kategoriyalar</text>`);
  y += 36;
  if (cats.length === 0) {
    parts.push(`<text x="${P}" y="${y + 40}" font-size="26" fill="${C.muted}">Bu oyda xarajat yozilmagan</text>`);
    y += 70;
  }
  const maxCat = Math.max(1, ...cats.map((c) => c.total));
  const barX = P;
  const barMaxW = W - 2 * P;
  for (const c of cats) {
    const pct = r.expense ? Math.round((c.total / r.expense) * 100) : 0;
    parts.push(`<text x="${P}" y="${y + 34}" font-size="28" fill="${C.primary}">${esc(c.category)}</text>`);
    parts.push(
      `<text x="${W - P}" y="${y + 34}" font-size="28" fill="${C.secondary}" text-anchor="end">${fmt(c.total)} <tspan fill="${C.muted}">· ${pct}%</tspan></text>`,
    );
    const w = Math.max(8, (c.total / maxCat) * barMaxW);
    parts.push(`<rect x="${barX}" y="${y + 50}" width="${barMaxW}" height="14" rx="7" fill="${C.grid}"/>`);
    parts.push(`<rect x="${barX}" y="${y + 50}" width="${w}" height="14" rx="7" fill="${C.series}"/>`);
    y += 92;
  }

  // Kunlar — ustunlar
  y += 28;
  parts.push(`<text x="${P}" y="${y}" font-size="30" font-weight="600" fill="${C.primary}">Kunlar bo'yicha</text>`);
  const maxDay = Math.max(0, ...r.days.map((d) => d.total));
  if (maxDay > 0) {
    parts.push(`<text x="${W - P}" y="${y}" font-size="24" fill="${C.muted}" text-anchor="end">eng ko'pi: ${fmt(maxDay)}</text>`);
  }
  y += 36;
  const chartH = 220;
  const n = 31; // ustun kengligi oy uzunligiga bog'liq bo'lmasin
  const slot = (W - 2 * P) / n;
  const colW = Math.max(6, slot - 6);
  parts.push(`<line x1="${P}" y1="${y + chartH}" x2="${W - P}" y2="${y + chartH}" stroke="${C.grid}" stroke-width="2"/>`);
  r.days.forEach((d, i) => {
    const x = P + i * slot + (slot - colW) / 2;
    if (d.total > 0) {
      const h = Math.max(6, (d.total / Math.max(1, maxDay)) * chartH);
      // yuqori uchi yumaloq, pastki uchi asosga yopishgan
      parts.push(
        `<path d="M${x},${y + chartH} v${-(h - 4)} q0,-4 4,-4 h${colW - 8} q4,0 4,4 v${h - 4} z" fill="${C.series}"/>`,
      );
    } else {
      parts.push(`<rect x="${x}" y="${y + chartH - 3}" width="${colW}" height="3" rx="1.5" fill="${C.grid}"/>`);
    }
    if ((i + 1) % 5 === 0 || i === 0) {
      parts.push(`<text x="${x + colW / 2}" y="${y + chartH + 34}" font-size="22" fill="${C.muted}" text-anchor="middle">${i + 1}</text>`);
    }
  });
  y += chartH + 70;

  if (r.rateNote) parts.push(`<text x="${P}" y="${y}" font-size="22" fill="${C.muted}">Kurs: ${esc(r.rateNote)}</text>`);
  parts.push(`<text x="${W - P}" y="${y}" font-size="22" fill="${C.muted}" text-anchor="end">@mfsv_ai_bot</text>`);
  const H = y + P - 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<rect width="${W}" height="${H}" fill="${C.surface}"/>
${parts.join("\n")}
</svg>`;
}

export function renderPng(svg: string): Buffer {
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Arial" } }).render().asPng());
}

/** Rasm ostidagi matn (Telegram HTML). */
export function reportCaption(r: MonthReport): string {
  const unit = r.currency === "UZS" ? "so'm" : r.currency;
  const lines = [
    `📊 <b>${esc(r.title)}</b> · ${esc(r.rangeLabel)}`,
    "",
    `💸 Xarajat: <b>${fmt(r.expense)} ${unit}</b>${foreignLine(r, "expense") ? ` (${esc(foreignLine(r, "expense")!)})` : ""}`,
    `💰 Daromad: <b>${fmt(r.income)} ${unit}</b>${foreignLine(r, "income") ? ` (${esc(foreignLine(r, "income")!)})` : ""}`,
    `⚖️ Balans: <b>${r.income - r.expense < 0 ? "−" : ""}${fmt(Math.abs(r.income - r.expense))} ${unit}</b>`,
  ];
  const f = r.forecast;
  if (f.daysLeft > 0 || f.items.length) {
    lines.push(
      "",
      `🔮 <b>Prognoz</b> (oy oxirigacha): ~${fmt(f.expectedExpense)} ${unit} xarajat, qoladi <b>${f.expectedBalance < 0 ? "−" : ""}${fmt(Math.abs(f.expectedBalance))} ${unit}</b>`,
    );
    if (f.dueExpense > 0) lines.push(`⏳ To'lanmagan majburiy: ${fmt(f.dueExpense)} ${unit} — /majburiy`);
  }
  if (r.categories.length) {
    lines.push("", "<b>Eng ko'p:</b>");
    for (const c of r.categories.slice(0, 3)) {
      lines.push(`${CATEGORY_EMOJI[c.category] ?? "•"} ${esc(c.category)} — ${fmt(c.total)} ${unit}`);
    }
  }
  if (r.otherCurrencies.length) {
    lines.push(
      "",
      `Kurs topilmadi, jamiga qo'shilmagan: ` +
        r.otherCurrencies.map((t) => `${t.kind === "expense" ? "💸" : "💰"} ${formatAmount(t.total, t.currency)}`).join(" · "),
    );
  }
  if (r.rateNote) lines.push("", `<i>Kurs: ${esc(r.rateNote)}</i>`);
  return lines.join("\n");
}
