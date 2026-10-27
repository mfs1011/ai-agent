import { z } from "zod";
import type { Db } from "../../db.ts";
import { nowIso } from "../../db.ts";
import type { ToolModule } from "../../core/agent.ts";
import { defineTool } from "../../core/tools.ts";

// Uzoq muddatli xotira: suhbat tarixi (oxirgi 12 xabar) unutiladi, bu yerdagi faktlar esa doim promptda.
// Faqat barqaror narsalar: kasb, maqsadlar, afzalliklar, oilaviy/moliyaviy holat. Bir martalik gaplar emas.

export type Memory = { id: number; text: string; updated_at: string };

/** Promptga sig'adigan miqdor. */
export const MEMORY_LIMIT = 50;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function listMemories(db: Db, userId: number, limit = MEMORY_LIMIT): Memory[] {
  return db
    .prepare("SELECT id, text, updated_at FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit) as Memory[];
}

/** Saqlaydi; aynan shu fakt bor bo'lsa — yangilamaydi (dublikat yo'q). */
export function saveMemory(db: Db, userId: number, text: string): { memory: Memory; existed: boolean } {
  const clean = text.trim().slice(0, 300);
  const same = listMemories(db, userId, 500).find((m) => norm(m.text) === norm(clean));
  if (same) return { memory: same, existed: true };
  const now = nowIso();
  const memory = db
    .prepare("INSERT INTO memories (user_id, text, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id, text, updated_at")
    .get(userId, clean, now, now) as Memory;
  return { memory, existed: false };
}

export function updateMemory(db: Db, userId: number, id: number, text: string): boolean {
  return db.prepare("UPDATE memories SET text = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(text.trim().slice(0, 300), nowIso(), id, userId).changes > 0;
}

export function forgetMemory(db: Db, userId: number, id: number): boolean {
  return db.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/** Prompt uchun: "#id fakt" ro'yxati (eskidan yangiga). */
export function memoryContext(db: Db, userId: number): string {
  return listMemories(db, userId)
    .reverse()
    .map((m) => `- #${m.id} ${m.text}`)
    .join("\n");
}

export function memoryTools(db: Db): ToolModule {
  return (ctx) => [
    defineTool({
      name: "memory_save",
      description:
        "Foydalanuvchi haqidagi BARQAROR faktni uzoq muddatga eslab qoladi: kasbi, ish joyi, oilasi, maqsadlari, afzalliklari " +
        "(masalan «javoblarni qisqa yoz»), doimiy holati. Foydalanuvchi «eslab qol» desa yoki o'zi haqida muhim narsa aytsa chaqir. " +
        "Bir martalik narsalar (bugungi xarajat, vaqtinchalik kayfiyat) — EMAS. Fakt — qisqa, uchinchi shaxsda: «Vue.js developer».",
      input: z.object({ fact: z.string().min(3).max(300) }),
      run: (input) => {
        const { memory, existed } = saveMemory(db, ctx.userId, input.fact);
        if (!existed) ctx.undo.push(() => forgetMemory(db, ctx.userId, memory.id));
        return JSON.stringify(existed ? { already_known: memory } : { saved: memory });
      },
    }),
    defineTool({
      name: "memory_update",
      description: "Eslab qolingan faktni yangilaydi (masalan maqsad o'zgardi). id — xotira ro'yxatidagi #raqam.",
      input: z.object({ id: z.number().int(), fact: z.string().min(3).max(300) }),
      run: (input) => JSON.stringify(updateMemory(db, ctx.userId, input.id, input.fact) ? { updated: input.id } : { error: `#${input.id} topilmadi` }),
    }),
    defineTool({
      name: "memory_forget",
      description: "Foydalanuvchi «buni unut» desa — faktni o'chiradi.",
      input: z.object({ id: z.number().int() }),
      run: (input) => JSON.stringify(forgetMemory(db, ctx.userId, input.id) ? { forgotten: input.id } : { error: `#${input.id} topilmadi` }),
    }),
  ];
}
