import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { forgetMemory, listMemories, memoryContext, memoryTools, saveMemory, updateMemory } from "../src/modules/memory/index.ts";

test("xotira: saqlash, dublikat yo'q, yangilash, unutish, boshqa user'ga tegmaydi", () => {
  const db = openDb(":memory:");
  const a = saveMemory(db, 1, "Vue.js developer");
  assert.equal(a.existed, false);
  assert.equal(saveMemory(db, 1, "  vue.js   DEVELOPER ").existed, true, "katta-kichik harf/bo'shliq farqi — dublikat");
  saveMemory(db, 1, "Maqsad: mashina uchun 50 mln yig'ish");
  assert.equal(listMemories(db, 1).length, 2);
  assert.equal(updateMemory(db, 1, a.memory.id, "Senior Vue.js developer"), true);
  assert.equal(updateMemory(db, 2, a.memory.id, "x"), false, "boshqa user");
  assert.equal(memoryContext(db, 1), `- #${a.memory.id} Senior Vue.js developer\n- #2 Maqsad: mashina uchun 50 mln yig'ish`);
  assert.equal(forgetMemory(db, 1, a.memory.id), true);
  assert.equal(listMemories(db, 1).length, 1);
  assert.equal(memoryContext(db, 99), "");
});

test("memory_save tool: undo bilan (ovoz tuzatilganda bekor qilinadi)", async () => {
  const db = openDb(":memory:");
  const ctx = { userId: 1, chatId: 1, source: "voice" as const, rawText: "", buttons: [], photos: [], undo: [] as (() => void)[] };
  const save = memoryTools(db)(ctx).find((t) => t.name === "memory_save")!;
  await save.run({ fact: "Toshkentda yashaydi" });
  assert.equal(listMemories(db, 1).length, 1);
  ctx.undo.forEach((f) => f());
  assert.equal(listMemories(db, 1).length, 0);
});
