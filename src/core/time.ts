// Mahalliy vaqt bilan ishlash. Toshkentda DST yo'q, shuning uchun qat'iy offset yetarli.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];

/** UTC vaqtni mahalliy "devor soati"ga siljitadi (getUTC* metodlari mahalliy qiymat beradi). */
function shifted(now: Date, offsetMin: number): Date {
  return new Date(now.getTime() + offsetMin * 60_000);
}

/** Mahalliy sana, YYYY-MM-DD. */
export function localDate(now: Date, offsetMin: number): string {
  return shifted(now, offsetMin).toISOString().slice(0, 10);
}

/** LLM uchun "hozir" konteksti: sana, hafta kuni, soat. */
export function nowContext(now: Date, offsetMin: number): string {
  const s = shifted(now, offsetMin);
  const hhmm = s.toISOString().slice(11, 16);
  return `${s.toISOString().slice(0, 10)} (${WEEKDAYS[s.getUTCDay()]}), soat ${hhmm}`;
}

/** Keyingi `hour:00` mahalliy vaqt (UTC Date sifatida). Hozir o'tib ketgan bo'lsa — ertaga. */
export function nextDailyRun(now: Date, hour: number, offsetMin: number): Date {
  const s = shifted(now, offsetMin);
  const targetLocal = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), hour, 0, 0);
  let utc = targetLocal - offsetMin * 60_000;
  if (utc <= now.getTime()) utc += DAY_MS;
  return new Date(utc);
}

export type Period = "today" | "week" | "month" | "last_month";

/** Davr uchun [from, to] mahalliy sanalar (ikkalasi ham kiradi). Hafta dushanbadan boshlanadi. */
export function periodRange(period: Period, now: Date, offsetMin: number): { from: string; to: string } {
  const s = shifted(now, offsetMin);
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth();
  const d = s.getUTCDate();
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const today = Date.UTC(y, m, d);
  switch (period) {
    case "today":
      return { from: iso(today), to: iso(today) };
    case "week": {
      const sinceMonday = (s.getUTCDay() + 6) % 7;
      return { from: iso(today - sinceMonday * DAY_MS), to: iso(today) };
    }
    case "month":
      return { from: iso(Date.UTC(y, m, 1)), to: iso(today) };
    case "last_month":
      return { from: iso(Date.UTC(y, m - 1, 1)), to: iso(Date.UTC(y, m, 0)) };
  }
}
