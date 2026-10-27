import { run, tail } from "../core/exec.ts";
import type { CodingAgent, CodingResult } from "./types.ts";

// Ixtiyoriy: Claude Code CLI (`claude -p`) kod yozuvchi agent sifatida. CODER=claude bilan yoqiladi.

const ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(npm run *)",
  "Bash(npm test*)",
  "Bash(node --test *)",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(ls *)",
].join(",");

const DISALLOWED_TOOLS = [
  "Bash(git commit*)",
  "Bash(git push*)",
  "Bash(git merge*)",
  "Bash(git rebase*)",
  "Bash(git reset*)",
  "Bash(git checkout*)",
  "Bash(git switch*)",
  "Bash(gh *)",
  "Bash(rm -rf*)",
  "Bash(curl *)",
  "Bash(wget *)",
].join(",");

export class ClaudeCoder implements CodingAgent {
  readonly name = "claude";
  private bin: string;
  private maxBudgetUsd: number;

  constructor(bin: string, maxBudgetUsd: number) {
    this.bin = bin;
    this.maxBudgetUsd = maxBudgetUsd;
  }

  async implement(prompt: string, cwd: string, timeoutMs: number): Promise<CodingResult> {
    const r = await run(
      this.bin,
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        ALLOWED_TOOLS,
        "--disallowedTools",
        DISALLOWED_TOOLS,
        "--max-budget-usd",
        String(this.maxBudgetUsd),
      ],
      { cwd, timeoutMs },
    );
    let out: { result?: string; is_error?: boolean; total_cost_usd?: number };
    try {
      out = JSON.parse(r.stdout);
    } catch {
      return { ok: false, summary: tail(r.stderr || r.stdout, 1500) };
    }
    return {
      ok: r.code === 0 && !out.is_error,
      summary: out.result?.trim() ?? tail(r.stderr, 1500),
      costUsd: out.total_cost_usd,
    };
  }
}
