import { test } from "node:test";
import assert from "node:assert/strict";
import { localDate, nextDailyRun, nowContext, periodRange } from "../src/core/time.ts";

const TASHKENT = 300;

test("localDate: UTC 20:00 Toshkentda ertangi kun", () => {
  assert.equal(localDate(new Date("2026-10-27T20:00:00Z"), TASHKENT), "2026-10-28");
  assert.equal(localDate(new Date("2026-10-27T18:59:00Z"), TASHKENT), "2026-10-27");
});

test("nowContext: sana, hafta kuni va soat", () => {
  assert.equal(nowContext(new Date("2026-10-27T09:05:00Z"), TASHKENT), "2026-10-27 (seshanba), soat 14:05");
});

test("nextDailyRun: bugungi soat hali kelmagan bo'lsa — bugun", () => {
  // Mahalliy 08:00, maqsad 10:00 -> bugun 10:00 = 05:00Z
  assert.equal(nextDailyRun(new Date("2026-10-27T03:00:00Z"), 10, TASHKENT).toISOString(), "2026-10-27T05:00:00.000Z");
});

test("nextDailyRun: soat o'tib ketgan bo'lsa — ertaga", () => {
  assert.equal(nextDailyRun(new Date("2026-10-27T05:00:00Z"), 10, TASHKENT).toISOString(), "2026-10-28T05:00:00.000Z");
});

test("periodRange: hafta dushanbadan, oy boshidan, o'tgan oy to'liq", () => {
  const now = new Date("2026-10-29T07:00:00Z"); // payshanba
  assert.deepEqual(periodRange("today", now, TASHKENT), { from: "2026-10-29", to: "2026-10-29" });
  assert.deepEqual(periodRange("week", now, TASHKENT), { from: "2026-10-26", to: "2026-10-29" });
  assert.deepEqual(periodRange("month", now, TASHKENT), { from: "2026-10-01", to: "2026-10-29" });
  assert.deepEqual(periodRange("last_month", now, TASHKENT), { from: "2026-09-01", to: "2026-09-30" });
});

test("periodRange: yakshanba haftaning oxirgi kuni", () => {
  const sunday = new Date("2026-11-01T07:00:00Z");
  assert.deepEqual(periodRange("week", sunday, TASHKENT), { from: "2026-10-26", to: "2026-11-01" });
});
