import type { Db } from "../db.ts";
import { nowIso } from "../db.ts";

// Ruxsatlar katalogi. Yangi imkoniyat qo'shilsa — shu yerga yoziladi va settings menyusida avtomatik chiqadi.
export const PERMISSIONS = [
  { key: "chat", title: "Muhokamada suhbat", desc: "Kanal muhokamalarida bot bilan suhbatlashish (faqat suhbat, hech narsani o'zgartirmaydi)" },
  { key: "agent", title: "Ishchi guruh", desc: "Ishchi va suhbat guruhlarida bot bilan ishlash" },
  { key: "finance", title: "Moliya", desc: "O'z xarajat/daromadlarini yozish va hisobot olish" },
  { key: "ideas", title: "Takliflar", desc: "Loyiha takliflarini ko'rish va baholash" },
  { key: "ideas.implement", title: "Taklifni bajarish", desc: "Taklifni bajarishga yuborish (PR ochiladi)" },
  { key: "feeds", title: "Kanallar", desc: "Kanal feedlarini boshqarish" },
  { key: "unlimited", title: "Limitsiz muhokama", desc: "Muhokama guruhlarida kunlik savollar limiti yo'q" },
  { key: "admin", title: "Admin", desc: "Ruxsat berish, sozlamalar, statistika" },
] as const;

export type Perm = (typeof PERMISSIONS)[number]["key"];

export const ALL_PERMS: Perm[] = PERMISSIONS.map((p) => p.key);

export function isPerm(s: string): s is Perm {
  return (ALL_PERMS as string[]).includes(s);
}

export function permTitle(p: Perm): string {
  return PERMISSIONS.find((x) => x.key === p)?.title ?? p;
}

export type UserRow = { id: number; username: string | null; first_name: string | null; last_seen: string; blocked?: number };

export class Access {
  private db: Db;
  readonly ownerId: number;

  constructor(db: Db, ownerId: number) {
    this.db = db;
    this.ownerId = ownerId;
  }

  isOwner(userId: number): boolean {
    return userId === this.ownerId;
  }

  /** Egasi — hamma ruxsat. Admin — hamma ruxsat (lekin admin berish/olishni faqat egasi qiladi). */
  perms(userId: number): Set<Perm> {
    if (this.isOwner(userId)) return new Set(ALL_PERMS);
    const rows = this.db.prepare("SELECT perm FROM permissions WHERE user_id = ?").all(userId) as { perm: string }[];
    const set = new Set(rows.map((r) => r.perm).filter(isPerm));
    return set.has("admin") ? new Set(ALL_PERMS) : set;
  }

  has(userId: number, perm: Perm): boolean {
    return this.perms(userId).has(perm);
  }

  /** Bevosita berilgan ruxsatlar (admin orqali kelganlar emas) — menyuda ko'rsatish uchun. */
  granted(userId: number): Set<Perm> {
    const rows = this.db.prepare("SELECT perm FROM permissions WHERE user_id = ?").all(userId) as { perm: string }[];
    return new Set(rows.map((r) => r.perm).filter(isPerm));
  }

  canManage(actorId: number, perm: Perm, targetId: number): boolean {
    if (targetId === this.ownerId) return false;
    if (perm === "admin") return this.isOwner(actorId);
    return this.has(actorId, "admin");
  }

  grant(actorId: number, targetId: number, perm: Perm): boolean {
    if (!this.canManage(actorId, perm, targetId)) return false;
    this.db
      .prepare("INSERT OR IGNORE INTO permissions (user_id, perm, granted_by, granted_at) VALUES (?, ?, ?, ?)")
      .run(targetId, perm, actorId, nowIso());
    return true;
  }

  revoke(actorId: number, targetId: number, perm: Perm): boolean {
    if (!this.canManage(actorId, perm, targetId)) return false;
    this.db.prepare("DELETE FROM permissions WHERE user_id = ? AND perm = ?").run(targetId, perm);
    return true;
  }

  touchUser(u: { id: number; username?: string; first_name?: string }) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO users (id, username, first_name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, last_seen = excluded.last_seen`,
      )
      .run(u.id, u.username ?? null, u.first_name ?? null, now, now);
  }

  /** Bloklangan — bot unga javob bermaydi. Egasini bloklab bo'lmaydi. */
  isBlocked(userId: number): boolean {
    if (this.isOwner(userId)) return false;
    const row = this.db.prepare("SELECT blocked FROM users WHERE id = ?").get(userId) as { blocked: number } | undefined;
    return row?.blocked === 1;
  }

  setBlocked(actorId: number, targetId: number, blocked: boolean): boolean {
    if (this.isOwner(targetId) || !this.has(actorId, "admin")) return false;
    if (!this.isOwner(actorId) && this.granted(targetId).has("admin")) return false; // adminni faqat egasi bloklaydi
    this.touchUser({ id: targetId });
    this.db.prepare("UPDATE users SET blocked = ? WHERE id = ?").run(blocked ? 1 : 0, targetId);
    return true;
  }

  getUser(id: number): UserRow | null {
    return (this.db.prepare("SELECT id, username, first_name, last_seen, blocked FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
  }

  /** Ruxsati borlar birinchi, keyin oxirgi faollar. */
  listUsers(limit: number, offset: number): (UserRow & { perm_count: number })[] {
    return this.db
      .prepare(
        `SELECT u.id, u.username, u.first_name, u.last_seen, u.blocked, COUNT(p.perm) AS perm_count
         FROM users u LEFT JOIN permissions p ON p.user_id = u.id
         GROUP BY u.id ORDER BY perm_count DESC, u.last_seen DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as (UserRow & { perm_count: number })[];
  }

  countUsers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }
}

export function displayName(u: { id: number; username?: string | null; first_name?: string | null } | null, id?: number): string {
  if (!u) return `ID ${id}`;
  if (u.username) return `@${u.username}`;
  return u.first_name || `ID ${u.id}`;
}
