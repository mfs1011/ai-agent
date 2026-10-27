import { z } from "zod";
import type { Db } from "../../db.ts";
import type { ToolModule } from "../../core/agent.ts";
import { defineTool } from "../../core/tools.ts";
import { localDate, periodRange } from "../../core/time.ts";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  addTransaction,
  deleteTransaction,
  formatAmount,
  recentTransactions,
  findDuplicate,
  report,
  setTransactionRate,
  toBase,
  updateTransaction,
} from "./repo.ts";
import { buildMonthReport, renderPng, reportCaption, reportSvg } from "./report-image.ts";
import type { RateProvider } from "./rates.ts";
import { addRecurring, deleteRecurring, forecastMonth, linkRecurringPayment, listRecurring, updateRecurring } from "./recurring.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Sana YYYY-MM-DD. Ko'rsatilmasa — bugun.");

export function financeTools(
  db: Db,
  opts: { tzOffsetMin: number; defaultCurrency: string; rates?: RateProvider },
): ToolModule {
  return (ctx) => [
    defineTool({
      name: "finance_add",
      description:
        "Xarajat yoki daromadni yozib qo'yadi. Har bir alohida xarid/tushum uchun alohida chaqiring. " +
        `Xarajat kategoriyalari: ${EXPENSE_CATEGORIES.join(", ")}. Daromad: ${INCOME_CATEGORIES.join(", ")}.`,
      input: z.object({
        kind: z.enum(["expense", "income"]),
        amount: z.number().positive().describe("Summa raqamda: 'yigirma besh ming' = 25000"),
        currency: z.string().optional().describe(`ISO kod, standart ${opts.defaultCurrency}`),
        category: z.string().describe("Yuqoridagi ro'yxatdan eng mosi"),
        note: z.string().optional().describe("Qisqa izoh: nima uchun / qayerda"),
        date: date.optional(),
        force: z.boolean().optional().describe("true — foydalanuvchi dublikat ogohlantirishidan keyin baribir yozishni tasdiqlaganda"),
      }),
      run: async (input) => {
        const tx0 = {
          userId: ctx.userId,
          kind: input.kind,
          amount: input.amount,
          currency: (input.currency ?? opts.defaultCurrency).toUpperCase(),
          category: input.category,
          note: input.note,
          occurredOn: input.date ?? localDate(new Date(), opts.tzOffsetMin),
          source: ctx.source,
          rawText: ctx.rawText,
        };
        // Dublikatdan himoya: yaqinda aynan shunday yozuv bo'lsa — yozmaymiz, foydalanuvchidan so'raymiz
        const dup = input.force ? null : findDuplicate(db, tx0);
        if (dup) {
          return JSON.stringify({
            not_saved: true,
            possible_duplicate: { id: dup.id, amount: formatAmount(dup.amount, dup.currency), category: dup.category, date: dup.occurred_on },
            instruction: "Yozilmadi. Foydalanuvchiga #id bilan bir xil ko'rinishini ayt va yana yozishni xohlasa (force: true) so'ra.",
          });
        }
        const tx = addTransaction(db, tx0);
        // Valyuta yozuvi: o'sha kungi CBU kursi saqlanadi
        if (tx.currency !== "UZS" && opts.rates) {
          const rate = (await opts.rates.forDate(tx.occurred_on))?.[tx.currency];
          if (rate) setTransactionRate(db, tx.id, rate);
        }
        ctx.buttons.push([{ text: `↩️ #${tx.id} bekor qilish`, data: `tx:undo:${tx.id}`, style: "danger" }]);
        ctx.undo.push(() => deleteTransaction(db, ctx.userId, tx.id));
        // Majburiy to'lovga mos kelsa — shu oy uchun "to'landi" (yozuv bekor qilinsa, belgi ham bekor bo'ladi)
        const linked = linkRecurringPayment(db, ctx.userId, tx, ctx.rawText);
        return JSON.stringify({
          saved: tx,
          formatted: formatAmount(tx.amount, tx.currency),
          ...(linked ? { recurring_paid: `${linked.name} (majburiy, shu oy to'landi deb belgilandi)` } : {}),
        });
      },
    }),

    defineTool({
      name: "finance_update",
      description: "Mavjud yozuvni tuzatadi (summa, kategoriya, sana, izoh). id kerak — bilmasangiz avval finance_recent.",
      input: z.object({
        id: z.number().int(),
        kind: z.enum(["expense", "income"]).optional(),
        amount: z.number().positive().optional(),
        currency: z.string().optional(),
        category: z.string().optional(),
        note: z.string().optional(),
        date: date.optional(),
      }),
      run: (input) => {
        const tx = updateTransaction(db, ctx.userId, input.id, {
          kind: input.kind,
          amount: input.amount,
          currency: input.currency?.toUpperCase(),
          category: input.category,
          note: input.note,
          occurred_on: input.date,
        });
        return tx ? JSON.stringify({ updated: tx }) : JSON.stringify({ error: `#${input.id} topilmadi` });
      },
    }),

    defineTool({
      name: "finance_delete",
      description: "Yozuvni o'chiradi.",
      input: z.object({ id: z.number().int() }),
      run: (input) =>
        JSON.stringify(deleteTransaction(db, ctx.userId, input.id) ? { deleted: input.id } : { error: `#${input.id} topilmadi` }),
    }),

    defineTool({
      name: "finance_recent",
      description: "Oxirgi yozuvlar ro'yxati (id bilan). Tuzatish/o'chirishdan oldin kerak bo'ladi.",
      needsResult: true,
      input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      run: (input) => JSON.stringify(recentTransactions(db, ctx.userId, input.limit ?? 10)),
    }),

    defineTool({
      name: "finance_report",
      needsResult: true,
      description:
        "Davr bo'yicha hisobot: jami xarajat/daromad va kategoriyalar. period yoki from+to bering. " +
        "Shu oy (period=month yoki ko'rsatilmagan) uchun foydalanuvchiga rasmli hisobot avtomatik yuboriladi — unda javob matnida faqat 1-2 gaplik xulosa yoz. " +
        "Boshqa davrlarda summalarni o'qilishi oson formatda (25 000 so'm) va eng katta kategoriyalarni ko'rsat.",
      input: z.object({
        period: z.enum(["today", "week", "month", "last_month"]).optional(),
        from: date.optional(),
        to: date.optional(),
      }),
      run: async (input) => {
        const custom = input.from && input.to;
        const fx = (await opts.rates?.get()) ?? null;
        const range = custom
          ? { from: input.from!, to: input.to! }
          : periodRange(input.period ?? "month", new Date(), opts.tzOffsetMin);
        // Shu oy hisobotiga chiroyli rasm ham qo'shiladi.
        if (!custom && (input.period ?? "month") === "month") {
          const m = buildMonthReport(db, ctx.userId, new Date(), opts.tzOffsetMin, opts.defaultCurrency, fx);
          ctx.photos.push({ png: renderPng(reportSvg(m)), caption: reportCaption(m) });
        }
        const rep = report(db, ctx.userId, range.from, range.to);
        // Boshqa valyutalar kurs bo'yicha asosiy valyutaga o'girilgan jami (model to'g'ri xulosa qilishi uchun)
        const sumBase = (kind: string) =>
          rep.totals.filter((t) => t.kind === kind).reduce((a, t) => a + (toBase(t, fx?.rates ?? null, opts.defaultCurrency) ?? 0), 0);
        return JSON.stringify({
          ...rep,
          converted: { currency: opts.defaultCurrency, expense: Math.round(sumBase("expense")), income: Math.round(sumBase("income")), note: "har yozuv o'z kunidagi CBU kursi bilan" },
        });
      },
    }),

    defineTool({
      name: "recurring_add",
      description:
        "Oylik majburiy to'lov (ijara, internet, kredit, obuna...) yoki muntazam daromad (maosh) qo'shadi. " +
        "Har oy shu kuni eslatma keladi va prognozga kiradi. Bir martalik xarajat uchun EMAS — u finance_add.",
      input: z.object({
        name: z.string().describe("Qisqa nom: Ijara, Internet, Maosh"),
        amount: z.number().positive(),
        currency: z.string().optional().describe(`ISO kod, standart ${opts.defaultCurrency}`),
        category: z.string().describe("Kategoriya ro'yxatidan"),
        day: z.number().int().min(1).max(31).describe("Oyning qaysi kuni to'lanadi/tushadi"),
        kind: z.enum(["expense", "income"]).optional().describe("Standart: expense"),
      }),
      run: (input) => {
        const r = addRecurring(db, {
          userId: ctx.userId,
          kind: input.kind ?? "expense",
          name: input.name,
          amount: input.amount,
          currency: (input.currency ?? opts.defaultCurrency).toUpperCase(),
          category: input.category,
          day: input.day,
        });
        ctx.undo.push(() => deleteRecurring(db, ctx.userId, r.id));
        return JSON.stringify({ added: r });
      },
    }),

    defineTool({
      name: "recurring_update",
      description: "Majburiy to'lovni o'zgartiradi (summa, kun, nom, kategoriya) yoki to'xtatadi/yoqadi (active). id kerak — bilmasangiz recurring_list.",
      input: z.object({
        id: z.number().int(),
        name: z.string().optional(),
        amount: z.number().positive().optional(),
        currency: z.string().optional(),
        category: z.string().optional(),
        day: z.number().int().min(1).max(31).optional(),
        kind: z.enum(["expense", "income"]).optional(),
        active: z.boolean().optional().describe("false — vaqtincha to'xtatish"),
      }),
      run: (input) => {
        const r = updateRecurring(db, ctx.userId, input.id, {
          name: input.name,
          amount: input.amount,
          currency: input.currency?.toUpperCase(),
          category: input.category,
          day: input.day,
          kind: input.kind,
          active: input.active === undefined ? undefined : input.active ? 1 : 0,
        });
        return JSON.stringify(r ? { updated: r } : { error: `#${input.id} topilmadi` });
      },
    }),

    defineTool({
      name: "recurring_delete",
      description: "Majburiy to'lovni butunlay o'chiradi.",
      input: z.object({ id: z.number().int() }),
      run: (input) =>
        JSON.stringify(deleteRecurring(db, ctx.userId, input.id) ? { deleted: input.id } : { error: `#${input.id} topilmadi` }),
    }),

    defineTool({
      name: "recurring_list",
      description: "Majburiy to'lovlar va muntazam daromadlar ro'yxati (id, summa, kun, shu oy holati).",
      needsResult: true,
      input: z.object({}),
      run: async () => {
        const f = forecastMonth(db, ctx.userId, new Date(), opts.tzOffsetMin, opts.defaultCurrency, (await opts.rates?.get()) ?? null);
        return JSON.stringify({ items: f.items, inactive: listRecurring(db, ctx.userId, true).filter((r) => !r.active) });
      },
    }),

    defineTool({
      name: "finance_forecast",
      description:
        "Oy oxirigacha prognoz: qancha sarflanadi, qancha qoladi; to'lanmagan majburiy to'lovlar; kelasi oy taxmini. " +
        "Javobda asosiy raqamlarni qalin yoz va bu taxmin ekanini ayt.",
      needsResult: true,
      input: z.object({}),
      run: async () =>
        JSON.stringify(forecastMonth(db, ctx.userId, new Date(), opts.tzOffsetMin, opts.defaultCurrency, (await opts.rates?.get()) ?? null)),
    }),
  ];
}
