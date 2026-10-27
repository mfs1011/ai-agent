import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { JobQueue } from "../src/core/jobs.ts";
import { getSuggestion, insertSuggestion, slugify, transition } from "../src/modules/ideas/repo.ts";
import { JOB_IMPLEMENT, startImplement } from "../src/modules/ideas/index.ts";
import { buildPrompt } from "../src/modules/ideas/implement.ts";

const sample = { title: "Ovozli xabarda bir nechta xarajat", problem: "p", proposal: "q", effort: "S", area: "finance" };

test("slugify: o'zbekcha apostroflar va bo'sh joylar", () => {
  assert.equal(slugify("Kategoriya bo‘yicha oylik limit qo'shish"), "kategoriya-boyicha-oylik-limit-qoshish");
  assert.equal(slugify("!!!"), "change");
  assert.ok(slugify("a".repeat(100)).length <= 40);
});

test("transition: faqat ruxsat etilgan holatdan", () => {
  const db = openDb(":memory:");
  const s = insertSuggestion(db, sample);
  assert.equal(transition(db, s.id, ["proposed"], "liked"), true);
  assert.equal(transition(db, s.id, ["proposed"], "liked"), false);
  assert.equal(getSuggestion(db, s.id)?.status, "liked");
});

test("startImplement: ikki marta bosilsa bitta ish navbatga tushadi", () => {
  const db = openDb(":memory:");
  const jobs = new JobQueue(db);
  const s = insertSuggestion(db, sample);
  transition(db, s.id, ["proposed"], "liked");
  startImplement({ db, jobs }, s.id, 42);
  const second = startImplement({ db, jobs }, s.id, 42);
  assert.match(second, /qayta ishga tushirib bo'lmaydi/);
  const count = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = ?").get(JOB_IMPLEMENT) as { n: number };
  assert.equal(count.n, 1);
  assert.equal(getSuggestion(db, s.id)?.status, "queued");
});

test("startImplement: rad etilgan taklif bajarilmaydi", () => {
  const db = openDb(":memory:");
  const jobs = new JobQueue(db);
  const s = insertSuggestion(db, sample);
  transition(db, s.id, ["proposed"], "disliked");
  assert.match(startImplement({ db, jobs }, s.id, 42), /qayta ishga tushirib bo'lmaydi/);
});

test("buildPrompt: agentga commit/push qilmaslik va tekshiruvni aytadi", () => {
  const db = openDb(":memory:");
  const prompt = buildPrompt(insertSuggestion(db, sample));
  assert.match(prompt, /npm run check/);
  assert.match(prompt, /git commit, git push va PR QILMA/);
});
