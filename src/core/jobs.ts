import type { Db } from "../db.ts";
import { nowIso } from "../db.ts";
import { errMessage, log } from "../log.ts";

// SQLite ustidagi oddiy navbat. Restart bo'lsa, "running" ishlar qaytadan navbatga tushadi.

export type Job = {
  id: number;
  type: string;
  payload: unknown;
  attempts: number;
};

export type JobHandler = (job: Job) => Promise<void>;

type Registered = { handler: JobHandler; concurrency: number; running: number };

export class JobQueue {
  private handlers = new Map<string, Registered>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<Promise<void>>();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  register(type: string, handler: JobHandler, concurrency = 1) {
    this.handlers.set(type, { handler, concurrency, running: 0 });
  }

  enqueue(type: string, payload: unknown = {}, opts: { runAt?: Date; maxAttempts?: number } = {}): number {
    const now = nowIso();
    const res = this.db
      .prepare(
        "INSERT INTO jobs (type, payload, max_attempts, run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(type, JSON.stringify(payload), opts.maxAttempts ?? 1, (opts.runAt ?? new Date()).toISOString(), now, now);
    queueMicrotask(() => this.tick());
    return Number(res.lastInsertRowid);
  }

  /** Shu turdagi navbatdagi (hali bajarilmagan) ish bormi. */
  hasPending(type: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM jobs WHERE type = ? AND status IN ('queued', 'running') LIMIT 1").get(type);
  }

  start(intervalMs = 2000) {
    this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(nowIso());
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  tick() {
    for (const [type, reg] of this.handlers) {
      while (reg.running < reg.concurrency) {
        const job = this.claim(type);
        if (!job) break;
        reg.running++;
        const p = this.run(job, reg).finally(() => {
          reg.running--;
          this.inFlight.delete(p);
        });
        this.inFlight.add(p);
      }
    }
  }

  private claim(type: string): Job | null {
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE type = ? AND status = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1)
         RETURNING id, type, payload, attempts`,
      )
      .get(nowIso(), type, nowIso()) as { id: number; type: string; payload: string; attempts: number } | undefined;
    if (!row) return null;
    return { id: row.id, type: row.type, payload: JSON.parse(row.payload), attempts: row.attempts };
  }

  private async run(job: Job, reg: Registered) {
    try {
      await reg.handler(job);
      this.db.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").run(nowIso(), job.id);
    } catch (e) {
      const msg = errMessage(e);
      log.error("job failed", { id: job.id, type: job.type, error: msg });
      const row = this.db.prepare("SELECT max_attempts FROM jobs WHERE id = ?").get(job.id) as { max_attempts: number };
      const retry = job.attempts < row.max_attempts;
      const retryAt = new Date(Date.now() + 30_000 * job.attempts).toISOString();
      this.db
        .prepare("UPDATE jobs SET status = ?, last_error = ?, run_at = CASE WHEN ? THEN ? ELSE run_at END, updated_at = ? WHERE id = ?")
        .run(retry ? "queued" : "failed", msg, retry ? 1 : 0, retryAt, nowIso(), job.id);
    }
  }
}
