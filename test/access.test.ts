import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { ALL_PERMS, Access } from "../src/core/access.ts";
import { ChatLog, Settings, Usage } from "../src/core/state.ts";

const OWNER = 100;
const ADMIN = 200;
const USER = 300;

function setup() {
  const db = openDb(":memory:");
  return { db, access: new Access(db, OWNER) };
}

test("egasida hamma ruxsat, oddiy userda hech narsa", () => {
  const { access } = setup();
  assert.deepEqual([...access.perms(OWNER)].sort(), [...ALL_PERMS].sort());
  assert.equal(access.perms(USER).size, 0);
});

test("admin hamma ruxsatga ega, lekin admin bera olmaydi", () => {
  const { access } = setup();
  assert.equal(access.grant(OWNER, ADMIN, "admin"), true);
  assert.equal(access.has(ADMIN, "finance"), true);
  assert.equal(access.grant(ADMIN, USER, "finance"), true);
  assert.equal(access.grant(ADMIN, USER, "admin"), false);
  assert.equal(access.has(USER, "admin"), false);
});

test("oddiy user ruxsat bera olmaydi, egasining ruxsatini hech kim o'zgartira olmaydi", () => {
  const { access } = setup();
  assert.equal(access.grant(USER, USER, "finance"), false);
  assert.equal(access.grant(OWNER, ADMIN, "admin"), true);
  assert.equal(access.revoke(ADMIN, OWNER, "finance"), false);
});

test("revoke ruxsatni olib tashlaydi", () => {
  const { access } = setup();
  access.grant(OWNER, USER, "finance");
  assert.equal(access.has(USER, "finance"), true);
  access.revoke(OWNER, USER, "finance");
  assert.equal(access.has(USER, "finance"), false);
});

test("settings: standart qiymat va saqlash", () => {
  const { db } = setup();
  const s = new Settings(db);
  assert.equal(s.workChatId(), null);
  assert.equal(s.publicDailyLimit(), 20);
  s.set("work_chat_id", "-1001");
  assert.equal(s.workChatId(), -1001);
});

test("chatLog: tarix user'dan boshlanib assistant bilan tugaydi, rollar birlashtiriladi", () => {
  const { db } = setup();
  const log = new ChatLog(db);
  log.append(1, 0, null, "assistant", "salom");
  log.append(1, 0, 5, "user", "Ali: a");
  log.append(1, 0, 6, "user", "Vali: b");
  log.append(1, 0, null, "assistant", "javob");
  log.append(1, 0, 5, "user", "Ali: c");
  assert.deepEqual(log.history(1, 0), [
    { role: "user", content: "Ali: a\n\nVali: b" },
    { role: "assistant", content: "javob" },
  ]);
});

test("usage: kunlik hisob", () => {
  const { db } = setup();
  const u = new Usage(db);
  u.increment(USER, "2026-10-27", "discussion");
  u.increment(USER, "2026-10-27", "discussion");
  assert.equal(u.count(USER, "2026-10-27", "discussion"), 2);
  assert.equal(u.count(USER, "2026-10-28", "discussion"), 0);
  assert.equal(u.totalForDay("2026-10-27", "discussion"), 2);
});

test("settings: ishchi va suhbat guruhlari alohida saqlanadi", () => {
  const { db } = setup();
  const s = new Settings(db);
  assert.equal(s.chatChatId(), null);
  s.set("work_chat_id", "-1");
  s.set("chat_chat_id", "-2");
  assert.equal(s.workChatId(), -1);
  assert.equal(s.chatChatId(), -2);
});

test("UpdateGuard: bir update faqat bir marta ishlanadi (restart'dan keyin ham)", async () => {
  const { UpdateGuard } = await import("../src/core/state.ts");
  const { db } = setup();
  const g = new UpdateGuard(db);
  assert.equal(g.claim(100), true);
  assert.equal(g.claim(100), false, "qayta kelgan update o'tkazib yuboriladi");
  assert.equal(new UpdateGuard(db).claim(100), false, "yangi jarayon ham ko'radi (DB'da)");
  assert.equal(g.claim(101), true);
});

test("InFlight: o'chishdan oldin ishlanayotgan update tugashini kutadi", async () => {
  const { InFlight } = await import("../src/core/state.ts");
  const f = new InFlight();
  let done = false;
  const work = f.track(async () => {
    await new Promise((r) => setTimeout(r, 30));
    done = true;
  });
  assert.equal(f.size, 1);
  assert.equal(await f.idle(1000), true);
  assert.equal(done, true);
  await work;
  const slow = f.track(() => new Promise((r) => setTimeout(r, 200)));
  assert.equal(await f.idle(20), false, "timeout'dan keyin kutmaydi");
  await slow;
});

test("bloklash: admin bloklaydi, egasini bloklab bo'lmaydi, oddiy user bloklay olmaydi", () => {
  const { access } = setup();
  access.touchUser({ id: USER });
  assert.equal(access.isBlocked(USER), false);
  assert.equal(access.setBlocked(USER, ADMIN, true), false, "huquqsiz");
  assert.equal(access.setBlocked(OWNER, USER, true), true);
  assert.equal(access.isBlocked(USER), true);
  assert.equal(access.setBlocked(OWNER, OWNER, true), false);
  assert.equal(access.isBlocked(OWNER), false);
  access.grant(OWNER, ADMIN, "admin");
  assert.equal(access.setBlocked(ADMIN, USER, false), true, "admin blokdan chiqaradi");
  assert.equal(access.isBlocked(USER), false);
  access.touchUser({ id: USER, username: "x" });
  access.setBlocked(OWNER, USER, true);
  access.touchUser({ id: USER, username: "y" });
  assert.equal(access.isBlocked(USER), true, "faollik bloklashni bekor qilmaydi");
});
