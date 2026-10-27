# ai-agent — agentlar uchun qoidalar

Bu fayl loyihada kod yozadigan agentlar (agy, Claude Code) uchun. Odamlar uchun — README.md.

## Stack
- Node.js 24+, TypeScript **build'siz**: `node src/index.ts` (type stripping). Shuning uchun:
  - faqat "erasable" sintaksis: `enum`, `namespace`, constructor parameter properties — **yo'q**;
  - importlar `.ts` kengaytmasi bilan: `import { x } from "./x.ts"`;
  - tip importlari `import type`.
- DB: `node:sqlite` (`src/db.ts`). Yangi jadval/ustun — `migrations` massivining **oxiriga** yangi element. Eskisini o'zgartirmang.
- Telegram: grammY. LLM: `LlmRunner` interfeysi (`src/llm/types.ts`), hozir `AgyRunner` (agy CLI).
- Testlar: `node:test` + `node:assert/strict`, `test/*.test.ts`. DB testlari `openDb(":memory:")` bilan.

## Tekshiruv
`npm run check` = `tsc --noEmit` + testlar. PR faqat shu o'tsa ochiladi.

## Tuzilma
- `src/core/` — agent (router), tool'lar, ruxsatlar, navbat, vaqt, holat.
- `src/modules/<nom>/` — har bir yo'nalish: `repo.ts` (DB), `tools.ts`/`index.ts` (agent tool'lari, fon ishlari).
- `src/bot/` — Telegram: `settings.ts` (DM — faqat sozlamalar), `groups.ts` (ishchi guruh + muhokama).
- `src/llm/` — CLI provayderlar.

## Yangi modul qo'shish
1. `src/modules/<nom>/` — repo va `defineTool(...)` bilan tool'lar (Zod sxema).
2. Kerak bo'lsa `src/core/access.ts` `PERMISSIONS`ga yangi ruxsat.
3. `src/index.ts`dagi `modules` ro'yxatiga `{ perm, tools }`.
4. Testlar.

## Qoidalar
- Foydalanuvchiga ko'rinadigan matnlar — o'zbek tilida.
- Muhokama rejimida (begona odamlar) hech qanday tool yo'q — buni o'zgartirmang.
- Secretlar faqat `.env`da. `data/` — runtime ma'lumotlar, tegmang.
- Commit, push, PR qilmang — tizim o'zi qiladi.
