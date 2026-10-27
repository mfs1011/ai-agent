import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyRunner, parseAgyOutput, safeEnv } from "../src/llm/agy.ts";

test("parseAgyOutput: ogohlantirish qatoridan keyingi JSON o'qiladi", () => {
  const stdout =
    'jetski: no output produced — a tool required the "command" permission\n' +
    '{"status":"SUCCESS","response":"","denied_actions":[{"action":"command"}]}\n';
  assert.deepEqual(parseAgyOutput(stdout), { status: "SUCCESS", response: "", denied_actions: [{ action: "command" }] });
  assert.equal(parseAgyOutput("garbage"), null);
});

test("safeEnv: secretlar agy'ga o'tmaydi", () => {
  const env = safeEnv({ HOME: "/h", PATH: "/bin", BOT_TOKEN: "x", OPENAI_API_KEY: "y", GH_TOKEN: "z" });
  assert.deepEqual(env, { HOME: "/h", PATH: "/bin" });
});

test("buildArgs: sandbox doim, tahrirlash faqat so'ralganda, sxema JSON sifatida", () => {
  const runner = new AgyRunner({ bin: "agy", model: "m", sandboxDir: mkdtempSync(join(tmpdir(), "agy-")), timeoutMs: 60_000 });
  const chat = runner.buildArgs({ prompt: "hi" });
  assert.ok(chat.includes("--sandbox"));
  assert.ok(!chat.includes("--mode"));
  assert.ok(!chat.includes("--dangerously-skip-permissions"));
  assert.deepEqual(chat.slice(0, 2), ["-p", "hi"]);
  assert.equal(chat[chat.indexOf("--print-timeout") + 1], "60s");

  const code = runner.buildArgs({ prompt: "x", allowEdits: true, schema: { type: "object" }, model: "smart" });
  assert.equal(code[code.indexOf("--mode") + 1], "accept-edits");
  assert.equal(code[code.indexOf("--json-schema") + 1], '{"type":"object"}');
  assert.equal(code[code.indexOf("--model") + 1], "smart");
});

test("Semaphore: bir vaqtda N tadan ko'p ishlamaydi", async () => {
  const { Semaphore } = await import("../src/llm/agy.ts");
  const sem = new Semaphore(2);
  let active = 0;
  let max = 0;
  const job = () =>
    sem.use(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(max, 2);
});

test("stripThoughtMarker: boshidagi 'thought' belgisi olib tashlanadi, oddiy matn o'zgarmaydi", async () => {
  const { stripThoughtMarker } = await import("../src/llm/agy.ts");
  assert.equal(stripThoughtMarker("thought\nKecha tushlikka 42 000"), "Kecha tushlikka 42 000");
  assert.equal(stripThoughtMarker("  thought\n\nSalom"), "Salom");
  assert.equal(stripThoughtMarker("thoughtful javob"), "thoughtful javob");
  assert.equal(stripThoughtMarker("Salom"), "Salom");
});

test("run: signal bilan jarayon darhol o'ldiriladi", async () => {
  const { run } = await import("../src/core/exec.ts");
  const ctrl = new AbortController();
  const t0 = Date.now();
  const p = run("sleep", ["10"], { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 50);
  const r = await p;
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - t0 < 2000, "10 soniya kutilmadi");
});

test("safeEnv: alohida agy profili (AGY_HOME) HOME'ni almashtiradi", () => {
  assert.equal(safeEnv({ HOME: "/Users/me", PATH: "/bin" }, "/srv/bot/agy-home").HOME, "/srv/bot/agy-home");
  assert.equal(safeEnv({ HOME: "/Users/me" }).HOME, "/Users/me");
});
