import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AbortedError, run, tail } from "../core/exec.ts";
import type { CodingAgent, CodingResult, LlmRequest, LlmResult, LlmRunner } from "./types.ts";

// Antigravity CLI: `agy -p "<prompt>" --output-format json [--json-schema ...]`.
// Headless rejimda terminal buyruqlari va fayl yozish ruxsatsiz avtomatik rad etiladi.

type AgyJson = {
  status?: string;
  response?: string;
  structured_output?: unknown;
  denied_actions?: { action: string }[];
};

/**
 * agy'ga botning secretlari (BOT_TOKEN, API kalitlar) o'tmasligi kerak:
 * muhokamadagi begona odam prompt-injection qilsa ham env'dan hech narsa ololmaydi.
 */
export function safeEnv(env: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  const keep = ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM", "SHELL"];
  const out: NodeJS.ProcessEnv = Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  // Alohida profil: agy sozlamalari va login shu HOME ichidagi ~/.gemini'dan olinadi
  if (home) out.HOME = home;
  return out;
}

export function parseAgyOutput(stdout: string): AgyJson | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as AgyJson;
    } catch {
      // keyingi qatorni ko'ramiz
    }
  }
  return null;
}

/** Gemini ba'zan javob boshiga ichki "thought" belgisini qo'shib yuboradi — foydalanuvchiga ko'rsatmaymiz. */
export function stripThoughtMarker(text: string): string {
  return text.replace(/^\s*thought\s*(\n|$)/i, "");
}

/** stream-json qatori: matn bo'lagi (agent javobi) yoki yakuniy natija. */
export function parseStreamEvent(line: string): { delta?: string; result?: AgyJson } | null {
  let e: { event?: string; step_update?: { step_type?: string; text_delta?: string }; result?: AgyJson };
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e.event === "result" && e.result) return { result: e.result };
  const su = e.step_update;
  if (su?.step_type === "agent_response" && su.text_delta) return { delta: su.text_delta };
  return null;
}

/** Oddiy semafor: bir vaqtda N tadan ko'p agy jarayoni bo'lmasin (har biri ~220 MB RAM). */
export class Semaphore {
  private free: number;
  private waiters: (() => void)[] = [];
  constructor(n: number) {
    this.free = n;
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiters.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

export class AgyRunner implements LlmRunner {
  private bin: string;
  private model: string;
  private sandboxDir: string;
  private defaultTimeoutMs: number;
  private slots: Semaphore;
  private home: string | undefined;

  constructor(opts: { bin: string; model: string; sandboxDir: string; timeoutMs: number; maxConcurrent?: number; home?: string }) {
    this.bin = opts.bin;
    this.model = opts.model;
    this.sandboxDir = resolve(opts.sandboxDir);
    this.defaultTimeoutMs = opts.timeoutMs;
    this.slots = new Semaphore(opts.maxConcurrent ?? 2);
    this.home = opts.home ? resolve(opts.home) : undefined;
    mkdirSync(this.sandboxDir, { recursive: true });
  }

  buildArgs(req: LlmRequest): string[] {
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const args = [
      "-p",
      req.prompt,
      "--output-format",
      // stream-json: matn bo'laklari (text_delta) keladi. Sxema rejimida agy stream qilmaydi.
      req.onDelta && !req.schema ? "stream-json" : "json",
      "--print-timeout",
      `${Math.ceil(timeoutMs / 1000)}s`,
      "--sandbox",
      "--disable-slash-commands",
      "--model",
      req.model ?? this.model,
    ];
    if (req.allowEdits) args.push("--mode", "accept-edits");
    if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));
    return args;
  }

  async run(req: LlmRequest): Promise<LlmResult> {
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const stream = !!req.onDelta && !req.schema;
    let streamed = "";
    let final: AgyJson | null = null;
    const onStdoutLine = stream
      ? (line: string) => {
          const ev = parseStreamEvent(line);
          if (ev?.delta) {
            streamed += ev.delta;
            const visible = stripThoughtMarker(streamed);
            // "thought" belgisi hali to'liq kelmagan bo'lishi mumkin — kutamiz.
            if (visible && !/^\s*t(h(o(u(g(h(t)?)?)?)?)?)?\s*$/i.test(visible)) req.onDelta!(visible);
          }
          if (ev?.result) final = ev.result;
        }
      : undefined;
    const r = await this.slots.use(() =>
      run(this.bin, this.buildArgs(req), {
        cwd: req.cwd ?? this.sandboxDir,
        timeoutMs: timeoutMs + 15_000,
        env: safeEnv(process.env, this.home),
        onStdoutLine,
        signal: req.signal,
      }),
    );
    if (r.aborted || req.signal?.aborted) throw new AbortedError();
    const out = stream ? (final as AgyJson | null) : parseAgyOutput(r.stdout);
    if (!out) throw new Error(`agy javobini o'qib bo'lmadi (code ${r.code}): ${tail(r.stderr || r.stdout, 800)}`);
    if (out.status !== "SUCCESS") throw new Error(`agy: ${out.status ?? "nomalum holat"} ${tail(out.response ?? r.stderr, 500)}`);
    return {
      text: stripThoughtMarker(out.response ?? "").trim(),
      json: out.structured_output,
      denied: (out.denied_actions ?? []).map((a) => a.action),
    };
  }
}

export class AgyCoder implements CodingAgent {
  readonly name = "agy";
  private runner: AgyRunner;
  private model: string;

  constructor(runner: AgyRunner, model: string) {
    this.runner = runner;
    this.model = model;
  }

  async implement(prompt: string, cwd: string, timeoutMs: number): Promise<CodingResult> {
    const res = await this.runner.run({ prompt, cwd, model: this.model, allowEdits: true, timeoutMs });
    return { ok: true, summary: res.text };
  }
}
