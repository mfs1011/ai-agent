import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImage, mediaTools } from "../src/modules/media/images.ts";

const fakeAgy = (write: boolean) => {
  let cwd = "";
  return {
    get cwd() {
      return cwd;
    },
    async run(req: { cwd?: string; allowEdits?: boolean }) {
      cwd = req.cwd!;
      assert.equal(req.allowEdits, true, "fayl yozishga ruxsat faqat shu papkada");
      if (write) {
        writeFileSync(join(cwd, "small.png"), "x");
        writeFileSync(join(cwd, "image.png"), "PNGDATA-BIG");
      }
      return { text: "image.png", json: undefined, denied: [] };
    },
  };
};

test("generateImage: agy yaratgan eng katta rasm olinadi, vaqtinchalik papka o'chiriladi", async () => {
  const base = mkdtempSync(join(tmpdir(), "img-"));
  const llm = fakeAgy(true);
  const png = await generateImage(llm, base, "boxer dog");
  assert.equal(png.toString(), "PNGDATA-BIG");
  assert.ok(llm.cwd.startsWith(base));
  assert.equal(existsSync(llm.cwd), false);
});

test("generateImage: rasm yaratilmasa — tushunarli xato, papka baribir o'chadi", async () => {
  const base = mkdtempSync(join(tmpdir(), "img-"));
  const llm = fakeAgy(false);
  await assert.rejects(generateImage(llm, base, "x"), /Rasm yaratilmadi/);
  assert.equal(existsSync(llm.cwd), false);
});

test("image_generate tool: rasm chatga qo'shiladi, izoh HTML uchun xavfsiz", async () => {
  const base = mkdtempSync(join(tmpdir(), "img-"));
  const ctx = { userId: 1, chatId: 1, source: "text" as const, rawText: "", buttons: [], photos: [] as { png: Buffer; caption?: string }[], undo: [] };
  const [tool] = mediaTools({ llm: fakeAgy(true), baseDir: base })(ctx);
  await tool!.run({ prompt: "dog", caption: "It <boxer> & do'st" });
  assert.equal(ctx.photos.length, 1);
  assert.equal(ctx.photos[0]!.caption, "🎨 It &lt;boxer&gt; &amp; do'st");
});
