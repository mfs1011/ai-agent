import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyStt, cleanTranscript, sttPrompt } from "../src/stt/index.ts";

const opts = { filename: "v.ogg", mimeType: "audio/ogg", vocabulary: ["Korzinka"] };

test("sttPrompt: lug'at qo'shiladi", () => {
  assert.match(sttPrompt(["Payme", "Korzinka"]), /Payme, Korzinka/);
});

test("cleanTranscript: qo'shtirnoq va «» olib tashlanadi", () => {
  assert.equal(cleanTranscript(" «Taksiga 25 000 berdim» \n"), "Taksiga 25 000 berdim");
  assert.equal(cleanTranscript('"salom"'), "salom");
});

test("AgyStt: audio vaqtinchalik papkada, agy shu papkada ishlaydi, keyin papka o'chiriladi", async () => {
  const base = mkdtempSync(join(tmpdir(), "stt-"));
  let seenCwd = "";
  let seenAudio = "";
  const llm = {
    async run(req: { cwd?: string; prompt: string; onDelta?: (s: string) => void }) {
      seenCwd = req.cwd!;
      seenAudio = readFileSync(join(req.cwd!, "voice.ogg"), "utf8");
      req.onDelta?.("«Taksi");
      return { text: "«Taksiga 25 000»", json: undefined, denied: [] };
    },
  };
  const partials: string[] = [];
  const stt = new AgyStt(llm, base);
  const text = await stt.transcribe(Buffer.from("OGGDATA"), { ...opts, onPartial: (p) => partials.push(p) });
  assert.equal(text, "Taksiga 25 000");
  assert.equal(seenAudio, "OGGDATA");
  assert.ok(seenCwd.startsWith(base));
  assert.equal(existsSync(seenCwd), false, "vaqtinchalik papka o'chirildi");
  assert.deepEqual(partials, ["Taksi"]);
});

test("AgyStt: xato bo'lsa ham vaqtinchalik papka o'chiriladi", async () => {
  const base = mkdtempSync(join(tmpdir(), "stt-"));
  let cwd = "";
  const stt = new AgyStt(
    {
      async run(req: { cwd?: string }) {
        cwd = req.cwd!;
        throw new Error("agy xato");
      },
    },
    base,
  );
  await assert.rejects(stt.transcribe(Buffer.from("x"), opts));
  assert.equal(existsSync(cwd), false);
});
