import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string; aborted?: boolean };

/** Foydalanuvchi "⏹ To'xtatish"ni bosdi — jarayon bekor qilindi. */
export class AbortedError extends Error {
  constructor() {
    super("To'xtatildi");
    this.name = "AbortedError";
  }
}

export function isAborted(e: unknown): boolean {
  return e instanceof AbortedError || (e instanceof Error && e.name === "AbortError");
}

/** Shell'siz buyruq ishga tushiradi (argumentlar massiv — injection yo'q). Xato kodida throw qilmaydi. */
export function run(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    onStdoutLine?: (line: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return resolve({ code: -1, stdout: "", stderr: "", aborted: true });
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const cap = (s: string, chunk: Buffer) => (s.length > 2_000_000 ? s : s + chunk.toString());
    child.stdout.on("data", (c: Buffer) => {
      stdout = cap(stdout, c);
      if (!opts.onStdoutLine) return;
      pending += c.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) opts.onStdoutLine(line);
    });
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          stderr += `\n[timeout ${opts.timeoutMs}ms]`;
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : null;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, stdout, stderr, aborted });
    });
  });
}

/** Xato kodida throw qiladi. */
export async function runOk(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} → ${r.code}\n${tail(r.stderr || r.stdout, 1500)}`);
  return r.stdout;
}

export function tail(s: string, max: number): string {
  return s.length <= max ? s : "…" + s.slice(-max);
}
