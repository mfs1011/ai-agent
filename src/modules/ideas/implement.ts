import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "../../db.ts";
import type { Config } from "../../config.ts";
import { run, runOk, tail } from "../../core/exec.ts";
import type { Notifier } from "../../core/notify.ts";
import { clip } from "../../core/notify.ts";
import type { CodingAgent } from "../../llm/types.ts";
import { errMessage, log } from "../../log.ts";
import type { Suggestion } from "./repo.ts";
import { getSuggestion, slugify, updateSuggestion } from "./repo.ts";

// Taklifni bajarish: alohida git worktree -> kod yozuvchi agent (agy yoki claude CLI) -> tekshiruv -> commit -> push -> PR.
// Hech qachon merge qilmaydi va base branch'ga push qilmaydi. Merge — faqat foydalanuvchi qo'lda.

export function buildPrompt(s: Suggestion): string {
  return `Sen shu loyihaning dasturchisisan. Quyidagi taklifni amalga oshir.

## Taklif #${s.id}: ${s.title}
Muammo: ${s.problem}
Yechim: ${s.proposal}

Qoidalar:
- CLAUDE.md va mavjud kod uslubiga amal qil.
- Faqat shu taklif doirasida o'zgartir, ortiqcha refactor qilma.
- Xulq o'zgarsa, test qo'sh yoki yangila (test/ papkasi, node:test).
- Terminal buyruqlari bloklangan bo'lishi mumkin — bu normal. \`npm run check\` (typecheck + test) ni tizim o'zi ishga tushiradi, shuning uchun kodni diqqat bilan, tiplarga mos yoz.
- git commit, git push va PR QILMA — ularni tizim o'zi qiladi.
- .env, secretlar va data/ papkasiga tegma.

Oxirgi javobing — o'zbek tilida qisqa hisobot: nima o'zgardi (fayllar bilan), nima tekshirilishi kerak, nima qoldi yoki noaniq.`;
}

export async function implementSuggestion(
  deps: { db: Db; config: Config; coder: CodingAgent; notifier: Notifier; chatId: number },
  id: number,
) {
  const { db, config, coder, notifier, chatId } = deps;
  const s = getSuggestion(db, id);
  if (!s) throw new Error(`Taklif #${id} topilmadi`);
  if (!config.SELF_REPO_PATH) {
    updateSuggestion(db, id, { status: "failed", report: "SELF_REPO_PATH sozlanmagan" });
    await notifier.send(chatId, `❌ #${id}: SELF_REPO_PATH sozlanmagan — loyihaning alohida klonini ko'rsating.`);
    return;
  }

  const repo = resolve(config.SELF_REPO_PATH);
  const base = config.SELF_BASE_BRANCH;
  const branch = `agent/sg-${s.id}-${slugify(s.title)}`;
  const worktrees = resolve(config.SELF_WORKTREES_DIR);
  const wt = resolve(worktrees, `sg-${s.id}`);
  mkdirSync(worktrees, { recursive: true });

  const steps: string[] = [];
  const statusMsg = await notifier.send(chatId, `⚙️ #${s.id} boshlandi: ${s.title}`);
  const progress = async (line: string) => {
    steps.push(line);
    await notifier.edit(chatId, statusMsg, clip(`⚙️ #${s.id}: ${s.title}\n\n${steps.join("\n")}`)).catch(() => {});
  };

  updateSuggestion(db, s.id, { status: "running", branch });
  try {
    await progress("1/6 Repo yangilanmoqda…");
    await runOk("git", ["fetch", "origin", base], { cwd: repo });
    await run("git", ["worktree", "remove", "--force", wt], { cwd: repo });
    await run("git", ["branch", "-D", branch], { cwd: repo });
    await runOk("git", ["worktree", "add", "-b", branch, wt, `origin/${base}`], { cwd: repo });

    await progress("2/6 Paketlar o'rnatilmoqda…");
    await runOk("npm", ["ci", "--no-audit", "--no-fund"], { cwd: wt, timeoutMs: 10 * 60_000 });

    await progress(`3/6 Agent (${coder.name}) kod yozmoqda — bir necha daqiqa…`);
    const out = await coder.implement(buildPrompt(s), wt, config.IMPLEMENT_TIMEOUT_MIN * 60_000);
    if (!out.ok) throw new Error(`Agent xato bilan tugadi:\n${out.summary}`);
    const summary = out.summary || "(agent hisobot bermadi)";

    // Agent qoidaga qaramay commit qilgan bo'lsa ham, hammasi bitta toza commit'ga yig'iladi.
    await runOk("git", ["reset", "--soft", `origin/${base}`], { cwd: wt });
    await runOk("git", ["add", "-A"], { cwd: wt });
    const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd: wt });
    if (staged.code === 0) throw new Error(`Agent hech narsa o'zgartirmadi.\n\n${summary}`);

    await progress("4/6 Tekshiruv: npm run check…");
    const gate = await run("npm", ["run", "check"], { cwd: wt, timeoutMs: 10 * 60_000 });
    if (gate.code !== 0) throw new Error(`Tekshiruv o'tmadi:\n${tail(gate.stdout + gate.stderr, 1500)}`);

    await progress("5/6 Commit va push…");
    await runOk("git", ["commit", "-m", `feat(${s.area}): ${s.title}`, "-m", `Taklif #${s.id}`], { cwd: wt });
    const diffStat = await runOk("git", ["diff", "--stat", `origin/${base}...HEAD`], { cwd: wt });
    await runOk("git", ["push", "-u", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });

    await progress("6/6 PR ochilmoqda…");
    const body = [
      `## Taklif #${s.id}`,
      `**Muammo:** ${s.problem}`,
      `**Yechim:** ${s.proposal}`,
      "## Nima qilindi",
      summary,
      "## Tekshiruv",
      "`npm run check` — o'tdi.",
    ].join("\n\n");
    const prOut = await runOk("gh", ["pr", "create", "--base", base, "--head", branch, "--title", s.title, "--body", body], {
      cwd: wt,
    });
    const prUrl = prOut.trim().split("\n").pop() ?? "";

    updateSuggestion(db, s.id, { status: "pr_opened", pr_url: prUrl, report: summary });
    await notifier.edit(chatId, statusMsg, `✅ #${s.id}: ${s.title} — PR tayyor`).catch(() => {});
    await notifier.send(
      chatId,
      clip(
        `✅ **PR tayyor: #${s.id} ${s.title}**\n\n${clip(summary, 2500)}\n\n` +
          `**Fayllar**\n\`\`\`\n${clip(diffStat.trim(), 800)}\n\`\`\`\n` +
          `✔️ \`npm run check\` o'tdi. Merge — sizda.` +
          (out.costUsd ? `\nAgent xarajati: $${out.costUsd.toFixed(2)}` : ""),
      ),
      prUrl ? [[{ text: "🔗 PR'ni ochish", url: prUrl, style: "primary" }]] : [],
    );
  } catch (e) {
    const msg = errMessage(e);
    log.error("implement failed", { id: s.id, error: msg });
    updateSuggestion(db, s.id, { status: "failed", report: msg });
    await notifier.send(chatId, clip(`❌ **#${s.id} bajarilmadi:** ${s.title}\n\n\`\`\`\n${msg}\n\`\`\``), [
      [{ text: "🔁 Qayta urinish", data: `sg:do:${s.id}` }],
    ]);
  } finally {
    await run("git", ["worktree", "remove", "--force", wt], { cwd: repo }).catch(() => {});
  }
}
