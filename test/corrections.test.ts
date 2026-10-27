import { test } from "node:test";
import assert from "node:assert/strict";
import { Corrections } from "../src/bot/corrections.ts";

const base = { chatId: -1, userId: 7, voiceMsgId: 100, transcript: "taksiga 95 ming", transcriptMsgId: 101 };

test("Corrections: tuzatish bosilgach keyingi xabar shu ovozga tegishli, bir martalik", () => {
  const c = new Corrections();
  c.remember({ ...base, undo: [] });
  const turn = c.get(-1, 100)!;
  c.startEdit(turn);
  assert.equal(c.takePending(-1, 7)?.voiceMsgId, 100);
  assert.equal(c.takePending(-1, 7), null, "ikkinchi xabar oddiy xabar");
  assert.equal(c.takePending(-1, 8), null, "boshqa user'ga tegishli emas");
});

test("Corrections: 'Eshitdim' xabariga reply orqali topiladi", () => {
  const c = new Corrections();
  c.remember({ ...base, undo: [] });
  assert.equal(c.byTranscriptMsg(-1, 101)?.voiceMsgId, 100);
  assert.equal(c.byTranscriptMsg(-1, 999), null);
  assert.equal(c.byTranscriptMsg(-2, 101), null, "boshqa chat");
});

test("Corrections: revert oldingi amallarni bir marta bekor qiladi", () => {
  const c = new Corrections();
  let deleted = 0;
  c.remember({ ...base, undo: [() => deleted++, () => deleted++] });
  const turn = c.get(-1, 100)!;
  assert.equal(c.revert(turn), 2);
  assert.equal(c.revert(turn), 0, "ikkinchi marta hech narsa qilmaydi");
  assert.equal(deleted, 2);
});

test("Corrections: muddati o'tgan ovoz va tuzatish rejimi", () => {
  let now = 0;
  const c = new Corrections({ ttlMs: 1000, now: () => now });
  c.remember({ ...base, undo: [] });
  c.startEdit(c.get(-1, 100)!);
  now = 11 * 60 * 1000;
  assert.equal(c.takePending(-1, 7), null, "10 daqiqadan keyin tuzatish rejimi tugaydi");
  assert.equal(c.get(-1, 100), null);
});
