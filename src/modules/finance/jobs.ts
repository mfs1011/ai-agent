import type { Db } from "../../db.ts";
import type { Config } from "../../config.ts";
import type { Button } from "../../core/agent.ts";
import type { JobQueue } from "../../core/jobs.ts";
import type { Notifier } from "../../core/notify.ts";
import { localDate, nextDailyRun } from "../../core/time.ts";
import { errMessage, log } from "../../log.ts";
import { CATEGORY_EMOJI } from "./report-image.ts";
import type { Forecast, Recurring } from "./recurring.ts";
import { dueToday } from "./recurring.ts";
import { formatAmount } from "./repo.ts";

export const JOB_RECURRING_DAILY = "finance.recurring";
/** Eslatmalar shu soatda (mahalliy vaqt). */
const REMIND_HOUR = 9;

const fmt = (n: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/ /g, " ");

export function recurringButtons(r: Recurring, month: string): Button[][] {
  return [
    [
      { text: r.kind === "income" ? "✅ Tushdi" : "✅ To'landi", data: `rc:paid:${r.id}:${month}`, style: "success" },
      { text: "⏭ Bu oy yo'q", data: `rc:skip:${r.id}:${month}` },
    ],
  ];
}

export function recurringReminder(r: Recurring): string {
  const emoji = CATEGORY_EMOJI[r.category] ?? (r.kind === "income" ? "💰" : "📌");
  return r.kind === "income"
    ? `💰 **Bugun tushum kuni**\n${emoji} **${r.name}** — ${formatAmount(r.amount, r.currency)}`
    : `📅 **Bugun to'lov kuni**\n${emoji} **${r.name}** — ${formatAmount(r.amount, r.currency)} · ${r.category}`;
}

/** Majburiy to'lovlar va prognoz — Markdown. */
export function formatForecast(f: Forecast): string {
  const unit = f.currency === "UZS" ? "so'm" : f.currency;
  const lines = [`## 🔮 Prognoz · ${f.month}`, ""];
  if (f.items.length === 0) {
    lines.push("Majburiy to'lovlar hali kiritilmagan.", "", "> Masalan: *«har oy 5-sanada ijara 3 million»* yoki *«maosh har oy 10-sanada 8 million»*");
  } else {
    lines.push("**Majburiy to'lovlar va tushumlar**");
    for (const i of f.items) {
      const mark = i.status === "paid" ? "✅" : i.status === "skipped" ? "⏭" : "⏳";
      const sign = i.kind === "income" ? "+" : "−";
      lines.push(`- ${mark} ${i.dueOn.slice(8)}-sana · **${i.name}** ${sign}${formatAmount(i.amount, i.currency)} \`#${i.id}\``);
    }
  }
  lines.push(
    "",
    `**Oy oxirigacha (${f.daysLeft} kun qoldi)**`,
    `- 💸 Xarajat: taxminan **${fmt(f.expectedExpense)} ${unit}** (hozircha ${fmt(f.spent)})`,
    `- 💰 Daromad: **${fmt(f.expectedIncome)} ${unit}**`,
    `- ⚖️ Qoladi: ==${f.expectedBalance < 0 ? "−" : ""}${fmt(Math.abs(f.expectedBalance))} ${unit}==`,
  );
  if (f.dueExpense > 0) lines.push(`- ⏳ To'lanmagan majburiy: **${fmt(f.dueExpense)} ${unit}**`);
  lines.push(
    "",
    `**Kelasi oy:** xarajat ~${fmt(f.nextMonthExpense)} ${unit}` + (f.nextMonthIncome ? ` · daromad ${fmt(f.nextMonthIncome)} ${unit}` : ""),
    "",
    `> Kundalik o'zgaruvchan xarajat o'rtacha **${fmt(f.dailyVariable)} ${unit}** — prognoz shunga asoslangan, taxminiy.`,
  );
  return lines.join("\n");
}

export function registerFinanceJobs(deps: {
  db: Db;
  config: Config;
  jobs: JobQueue;
  notifier: Notifier;
  /** Eslatmalar qayerga: ishchi guruh (bo'lmasa — yuborilmaydi, DM faqat sozlamalar uchun). */
  targetChat: () => number | null;
}) {
  const { db, config, jobs, notifier } = deps;

  jobs.register(JOB_RECURRING_DAILY, async () => {
    try {
      const chat = deps.targetChat();
      const due = dueToday(db, new Date(), config.TZ_OFFSET_MINUTES);
      if (!chat) {
        if (due.length) log.warn("recurring reminders skipped: no work chat", { count: due.length });
        return;
      }
      const month = localDate(new Date(), config.TZ_OFFSET_MINUTES).slice(0, 7);
      for (const r of due) {
        await notifier.send(chat, recurringReminder(r), recurringButtons(r, month)).catch((e) =>
          log.error("recurring reminder failed", { id: r.id, error: errMessage(e) }),
        );
      }
    } finally {
      schedule();
    }
  });

  const schedule = () =>
    jobs.enqueue(JOB_RECURRING_DAILY, {}, { runAt: nextDailyRun(new Date(), REMIND_HOUR, config.TZ_OFFSET_MINUTES) });
  if (!jobs.hasPending(JOB_RECURRING_DAILY)) schedule();
}
