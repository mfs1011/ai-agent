import type { Db } from "../../db.ts";
import { nowIso } from "../../db.ts";
import type { Settings } from "../../core/state.ts";
import { setTransactionRate, unratedTransactions } from "./repo.ts";
import { errMessage, log } from "../../log.ts";

// Valyuta kurslari — O'zbekiston Markaziy banki (cbu.uz), bepul va kalitsiz.
// Kurs = 1 birlik valyuta necha so'm. Kun davomida keshlanadi; internet bo'lmasa oxirgi ma'lum kurs ishlatiladi.

const CBU_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type Rates = { date: string; fetchedAt: number; rates: Record<string, number> };

type CbuRow = { Ccy: string; Rate: string; Nominal: string; Date: string };

export function parseCbu(rows: CbuRow[]): Rates {
  const rates: Record<string, number> = { UZS: 1 };
  for (const r of rows) {
    const rate = Number(r.Rate) / (Number(r.Nominal) || 1);
    if (Number.isFinite(rate) && rate > 0) rates[r.Ccy] = rate;
  }
  return { date: rows[0]?.Date ?? "", fetchedAt: Date.now(), rates };
}

export class RateProvider {
  private settings: Settings;
  private fetchFn: typeof fetch;
  private db: Db | null;

  constructor(settings: Settings, fetchFn: typeof fetch = fetch, db: Db | null = null) {
    this.settings = settings;
    this.fetchFn = fetchFn;
    this.db = db;
  }

  /** Aniq kun kurslari (CBU arxivi), DB'da keshlanadi — o'tgan kun kursi o'zgarmaydi. */
  async forDate(ymd: string): Promise<Record<string, number> | null> {
    const cached = this.db?.prepare("SELECT rates FROM fx_daily WHERE day = ?").get(ymd) as { rates: string } | undefined;
    if (cached) return JSON.parse(cached.rates) as Record<string, number>;
    try {
      const res = await this.fetchFn(`https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/${ymd}/`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`CBU ${res.status}`);
      const { rates } = parseCbu((await res.json()) as CbuRow[]);
      if (Object.keys(rates).length > 1) {
        this.db?.prepare("INSERT OR REPLACE INTO fx_daily (day, rates, fetched_at) VALUES (?, ?, ?)").run(ymd, JSON.stringify(rates), nowIso());
      }
      return rates;
    } catch (e) {
      log.warn("fx rate for date failed", { day: ymd, error: errMessage(e) });
      return null;
    }
  }

  /** Kursi hali saqlanmagan valyuta yozuvlariga o'z kunidagi kursni yozadi. Nechta to'ldirildi. */
  async fillMissing(): Promise<number> {
    if (!this.db) return 0;
    let n = 0;
    for (const t of unratedTransactions(this.db)) {
      const rate = (await this.forDate(t.occurred_on))?.[t.currency];
      if (rate) {
        setTransactionRate(this.db, t.id, rate);
        n++;
      }
    }
    return n;
  }

  private cached(): Rates | null {
    try {
      const raw = this.settings.get("fx_rates");
      return raw ? (JSON.parse(raw) as Rates) : null;
    } catch {
      return null;
    }
  }

  /** Kurslar (so'mda). Olib bo'lmasa va keshda ham yo'q bo'lsa — null (hisobot valyutalarni alohida ko'rsatadi). */
  async get(): Promise<Rates | null> {
    const cached = this.cached();
    if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached;
    try {
      const res = await this.fetchFn(CBU_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`CBU ${res.status}`);
      const fresh = parseCbu((await res.json()) as CbuRow[]);
      this.settings.set("fx_rates", JSON.stringify(fresh));
      return fresh;
    } catch (e) {
      log.warn("fx rates fetch failed, using cache", { error: errMessage(e) });
      return cached;
    }
  }
}
