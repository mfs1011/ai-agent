import type { Db } from "../../db.ts";
import { nowIso } from "../../db.ts";

export type SuggestionStatus = "proposed" | "liked" | "disliked" | "queued" | "running" | "pr_opened" | "failed";

export type Suggestion = {
  id: number;
  title: string;
  problem: string;
  proposal: string;
  effort: string;
  area: string;
  status: SuggestionStatus;
  branch: string | null;
  pr_url: string | null;
  report: string | null;
};

export type NewSuggestion = Pick<Suggestion, "title" | "problem" | "proposal" | "effort" | "area">;

const COLS = "id, title, problem, proposal, effort, area, status, branch, pr_url, report";

export function insertSuggestion(db: Db, s: NewSuggestion): Suggestion {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO suggestions (title, problem, proposal, effort, area, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
    )
    .get(s.title, s.problem, s.proposal, s.effort, s.area, now, now) as Suggestion;
}

export function getSuggestion(db: Db, id: number): Suggestion | null {
  return (db.prepare(`SELECT ${COLS} FROM suggestions WHERE id = ?`).get(id) as Suggestion | undefined) ?? null;
}

export function listSuggestions(db: Db, statuses: SuggestionStatus[], limit = 20): Suggestion[] {
  const marks = statuses.map(() => "?").join(", ");
  return db
    .prepare(`SELECT ${COLS} FROM suggestions WHERE status IN (${marks}) ORDER BY id DESC LIMIT ?`)
    .all(...statuses, limit) as Suggestion[];
}

export function updateSuggestion(
  db: Db,
  id: number,
  patch: Partial<Pick<Suggestion, "status" | "branch" | "pr_url" | "report">>,
): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE suggestions SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...entries.map(([, v]) => v as string),
    nowIso(),
    id,
  );
}

/**
 * Holatni faqat ruxsat etilgan o'tishlar bo'yicha o'zgartiradi (atomik).
 * Masalan, bir taklifni ikki marta "Bajar" bosib ikki marta ishga tushirib bo'lmaydi.
 */
export function transition(db: Db, id: number, from: SuggestionStatus[], to: SuggestionStatus): boolean {
  const marks = from.map(() => "?").join(", ");
  const res = db
    .prepare(`UPDATE suggestions SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`)
    .run(to, nowIso(), id, ...from);
  return res.changes > 0;
}

/** Generatsiya uchun: avvalgi takliflar va ularga bergan bahongiz — model didingizni o'rganadi. */
export function feedbackHistory(db: Db, limit = 40): { title: string; status: SuggestionStatus }[] {
  return db.prepare("SELECT title, status FROM suggestions ORDER BY id DESC LIMIT ?").all(limit) as {
    title: string;
    status: SuggestionStatus;
  }[];
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[ʻʼ'‘’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "change";
}
