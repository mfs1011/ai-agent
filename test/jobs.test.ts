import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { JobQueue } from "../src/core/jobs.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function status(db: ReturnType<typeof openDb>, id: number) {
  return (db.prepare("SELECT status, attempts, last_error FROM jobs WHERE id = ?").get(id) as {
    status: string;
    attempts: number;
    last_error: string | null;
  });
}

test("ish bajariladi va done bo'ladi", async () => {
  const db = openDb(":memory:");
  const q = new JobQueue(db);
  const seen: unknown[] = [];
  q.register("t", async (job) => void seen.push(job.payload));
  q.start(10);
  const id = q.enqueue("t", { a: 1 });
  await sleep(50);
  await q.stop();
  assert.deepEqual(seen, [{ a: 1 }]);
  assert.equal(status(db, id).status, "done");
});

test("kelajakdagi ish vaqti kelmaguncha ishlamaydi", async () => {
  const db = openDb(":memory:");
  const q = new JobQueue(db);
  let ran = false;
  q.register("t", async () => void (ran = true));
  q.start(10);
  q.enqueue("t", {}, { runAt: new Date(Date.now() + 60_000) });
  await sleep(50);
  await q.stop();
  assert.equal(ran, false);
  assert.equal(q.hasPending("t"), true);
});

test("xato: urinishlar tugasa failed, xabar saqlanadi", async () => {
  const db = openDb(":memory:");
  const q = new JobQueue(db);
  q.register("t", async () => {
    throw new Error("boom");
  });
  q.start(10);
  const id = q.enqueue("t");
  await sleep(50);
  await q.stop();
  const s = status(db, id);
  assert.equal(s.status, "failed");
  assert.equal(s.last_error, "boom");
});

test("concurrency=1: bir vaqtda faqat bitta ish", async () => {
  const db = openDb(":memory:");
  const q = new JobQueue(db);
  let active = 0;
  let maxActive = 0;
  q.register(
    "t",
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active--;
    },
    1,
  );
  q.start(5);
  q.enqueue("t");
  q.enqueue("t");
  q.enqueue("t");
  await sleep(150);
  await q.stop();
  assert.equal(maxActive, 1);
});

test("restart: running qolgan ish qayta navbatga tushadi", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO jobs (type, status, run_at, created_at, updated_at) VALUES ('t', 'running', ?, ?, ?)",
  ).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const q = new JobQueue(db);
  let ran = 0;
  q.register("t", async () => void ran++);
  q.start(10);
  await sleep(50);
  await q.stop();
  assert.equal(ran, 1);
});
