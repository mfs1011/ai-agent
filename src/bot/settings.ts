import type { Composer, Context } from "grammy";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import type { Button } from "../core/agent.ts";
import type { Access, Perm } from "../core/access.ts";
import { PERMISSIONS, displayName, isPerm, permTitle } from "../core/access.ts";
import type { JobQueue } from "../core/jobs.ts";
import type { Settings, Usage } from "../core/state.ts";
import { localDate, periodRange } from "../core/time.ts";
import { JOB_FEED_POST, isJobsFeed } from "../modules/feeds/index.ts";
import { addFeed, deleteFeed, getChat, getFeed, listChannels, listFeeds, updateFeed, upsertChat } from "../modules/feeds/repo.ts";
import { ignoreNotModified, keyboard, rich } from "./ui.ts";

// Bot DM — faqat sozlamalar va statistika. Suhbat ishchi guruhda bo'ladi.

type Deps = {
  db: Db;
  config: Config;
  access: Access;
  settings: Settings;
  usage: Usage;
  jobs: JobQueue;
  safety: { discussionOpen: boolean };
};

type Screen = { text: string; buttons: Button[][] };

type Pending =
  | { kind: "grant_id" }
  | { kind: "feed_topic"; channelId: number }
  | { kind: "feed_edit"; feedId: number }
  | { kind: "feed_sources"; feedId: number };

const PAGE = 8;
const back = (data: string): Button[] => [{ text: "⬅️ Orqaga", data }];

export function setupSettings(dm: Composer<Context>, deps: Deps) {
  const { db, access, settings, usage, jobs, config } = deps;
  const pending = new Map<number, Pending>();

  // ---------- Ekranlar ----------

  const home = (userId: number): Screen => {
    const perms = access.perms(userId);
    if (perms.size === 0) {
      // Begona: faqat ID (egasi ruxsat berishi uchun), boshqa hech narsa
      return { text: `🔒 Bu bot yopiq.\n\nSizning ID: \`${userId}\``, buttons: [] };
    }
    if (!perms.has("admin") && !perms.has("feeds")) {
      const list = [...perms].map(permTitle).join(", ") || "yo'q";
      return {
        text:
          `👋 Sozlamalar faqat admin uchun.\n\nSizning ruxsatlaringiz: ${list}\n` +
          `ID: ${userId}\n\nBot bilan suhbat ishchi guruhda yoki kanal muhokamalarida bo'ladi.`,
        buttons: [],
      };
    }
    const rows: Button[][] = [];
    if (perms.has("admin")) {
      rows.push([{ text: "📊 **Statistika**", data: "st:stats" }]);
      rows.push([
        { text: "👥 Foydalanuvchilar", data: "st:users:0" },
        { text: "🔐 Ruxsatlar ro'yxati", data: "st:perms" },
      ]);
    }
    if (perms.has("feeds")) rows.push([{ text: "📢 Kanallar va feedlar", data: "st:chans" }]);
    if (perms.has("admin")) {
      rows.push([
        { text: "💬 Guruhlar", data: "st:work" },
        { text: "⚙️ Sozlamalar", data: "st:cfg" },
      ]);
    }
    return { text: "⚙️ **Boshqaruv paneli**", buttons: rows };
  };

  const stats = (): Screen => {
    const today = localDate(new Date(), config.TZ_OFFSET_MINUTES);
    const month = periodRange("month", new Date(), config.TZ_OFFSET_MINUTES);
    const one = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const sg = db.prepare("SELECT status, COUNT(*) AS n FROM suggestions GROUP BY status").all() as { status: string; n: number }[];
    const jobsRow = db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE updated_at >= ? GROUP BY status").all(
      new Date(Date.now() - 86_400_000).toISOString(),
    ) as { status: string; n: number }[];
    const fmt = (rows: { status: string; n: number }[]) => rows.map((r) => `${r.status}: ${r.n}`).join(", ") || "—";
    return {
      text: [
        "📊 **Statistika**",
        "",
        `👥 Foydalanuvchilar: ${access.countUsers()} (ruxsatli: ${one("SELECT COUNT(DISTINCT user_id) AS n FROM permissions")})`,
        `💬 Bugun: ishchi guruh ${usage.totalForDay(today, "work")} ta, muhokama ${usage.totalForDay(today, "discussion")} ta so'rov`,
        `💰 Shu oy moliya yozuvlari: ${one("SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL AND occurred_on BETWEEN ? AND ?", month.from, month.to)}`,
        `💡 Takliflar: ${fmt(sg)}`,
        `📢 Feedlar: ${one("SELECT COUNT(*) AS n FROM feeds WHERE enabled = 1")} faol, 7 kunda ${one("SELECT COUNT(*) AS n FROM posts WHERE feed_id IS NOT NULL AND created_at >= ?", new Date(Date.now() - 7 * 86_400_000).toISOString())} post`,
        `⚙️ Fon ishlari (24 soat): ${fmt(jobsRow)}`,
      ].join("\n"),
      buttons: [[{ text: "🔄 Yangilash", data: "st:stats" }], back("st:home")],
    };
  };

  const permsCatalog = (): Screen => ({
    text: "🔐 **Ruxsatlar ro'yxati**\n\n" + PERMISSIONS.map((p) => `- **${p.title}** \`${p.key}\` — ${p.desc}`).join("\n") +
      "\n\nEgasi va adminlarda hamma ruxsat bor. Admin ruxsatini faqat egasi beradi.\nMuhokama guruhlarida oddiy foydalanuvchilar ruxsatsiz faqat suhbatlasha oladi (kunlik limit bilan).",
    buttons: [back("st:home")],
  });

  const users = (page: number): Screen => {
    const list = access.listUsers(PAGE, page * PAGE);
    const total = access.countUsers();
    const rows: Button[][] = list.map((u) => [
      { text: `${access.isOwner(u.id) ? "👑" : u.blocked ? "🚫" : u.perm_count ? "🔑" : "👤"} ${displayName(u)} · ${u.perm_count}`, data: `st:user:${u.id}` },
    ]);
    const nav: Button[] = [];
    if (page > 0) nav.push({ text: "◀️", data: `st:users:${page - 1}` });
    if ((page + 1) * PAGE < total) nav.push({ text: "▶️", data: `st:users:${page + 1}` });
    if (nav.length) rows.push(nav);
    rows.push([{ text: "➕ ID orqali qo'shish", data: "st:grantid" }]);
    rows.push(back("st:home"));
    return {
      text: `👥 **Foydalanuvchilar** (${total})\n\nBot bilan biror joyda yozishgan odamlar shu yerda chiqadi. Ruxsat berish uchun tanlang.`,
      buttons: rows,
    };
  };

  const user = (actorId: number, targetId: number): Screen => {
    const u = access.getUser(targetId);
    if (access.isOwner(targetId)) {
      return { text: `👑 ${displayName(u, targetId)} — loyiha egasi, hamma ruxsat bor.`, buttons: [back("st:users:0")] };
    }
    const granted = access.granted(targetId);
    const rows: Button[][] = PERMISSIONS.filter((p) => access.canManage(actorId, p.key, targetId)).map((p) => [
      { text: `${granted.has(p.key) ? "✅" : "▫️"} ${p.title}`, data: `st:tg:${targetId}:${p.key}` },
    ]);
    const blocked = access.isBlocked(targetId);
    rows.push([
      blocked
        ? { text: "✅ Blokdan chiqarish", data: `st:blk:${targetId}`, style: "success" }
        : { text: "🚫 Bloklash — bot javob bermaydi", data: `st:blk:${targetId}`, style: "danger" },
    ]);
    rows.push(back("st:users:0"));
    return {
      text:
        `👤 **${displayName(u, targetId)}**\nID: \`${targetId}\`` +
        (blocked ? `\n\n🚫 **Bloklangan** — bot bu odamga hech qayerda javob bermaydi.` : "") +
        `\n\nRuxsatni yoqish/o'chirish uchun bosing. Ruxsatsiz odamga bot javob bermaydi.`,
      buttons: rows,
    };
  };

  const work = (): Screen => {
    const line = (id: number | null, cmd: string) =>
      id ? `${getChat(db, id)?.title ?? id} ✅` : `sozlanmagan — guruh oching, botni admin qiling, guruhda ${cmd} yozing`;
    const workId = settings.workChatId();
    const chatId = settings.chatChatId();
    const buttons: Button[][] = [];
    if (workId) buttons.push([{ text: "🔌 Ishchi guruhni uzish", data: "st:work:unset" }]);
    if (chatId) buttons.push([{ text: "🔌 Suhbat guruhini uzish", data: "st:work:unsetchat" }]);
    buttons.push(back("st:home"));
    return {
      text:
        `🛠 **Ishchi guruh:** ${line(workId, "/setup_work")}\nMoliya, hisobotlar, takliflar va vazifalar.\n\n` +
        `💬 **Suhbat guruhi:** ${line(chatId, "/setup_chat")}\nIstalgan savol va erkin suhbat, internetdan qidirish bilan.`,
      buttons,
    };
  };

  const cfg = (userId: number): Screen => {
    const limit = settings.publicDailyLimit();
    const enabled = settings.get("discussion_enabled") !== "0";
    const status = !enabled
      ? "⚪️ o'chirilgan — bot muhokamalarda hech kimga javob bermaydi"
      : "🟢 yoqilgan — faqat «Muhokamada suhbat» ruxsati borlarga";
    const rows: Button[][] = [
      [
        enabled
          ? { text: "⏸ Muhokamada javob berishni o'chirish", data: "st:disc", style: "danger" }
          : { text: "▶️ Muhokamada javob berishni yoqish", data: "st:disc", style: "success" },
      ],
      [
        { text: "➖5", data: "st:lim:-5" },
        { text: `Kunlik limit: ${limit}`, data: "st:cfg" },
        { text: "➕5", data: "st:lim:5" },
      ],
    ];
    rows.push(back("st:home"));
    return {
      text:
        `⚙️ **Sozlamalar**\n\n` +
        `💬 **Kanal muhokamalari:** ${status}\n` +
        `Begonalarga bot javob bermaydi (jim). Ruxsat berish yoki bloklash: 👥 Foydalanuvchilar.\n` +
        `\n📊 Muhokamada kunlik limit: **${limit}** ta savol («Limitsiz muhokama» ruxsatisizlar uchun)` +
        `\n💡 Takliflar har kuni: ${config.SUGGEST_HOUR === null ? "o'chiq" : `soat ${config.SUGGEST_HOUR}:00`}`,
      buttons: rows,
    };
  };

  const channels = (): Screen => {
    const list = listChannels(db);
    const rows: Button[][] = list.map((c) => [
      { text: `📢 ${c.title ?? c.id} · ${listFeeds(db, c.id).length} feed`, data: `st:chan:${c.id}` },
    ]);
    rows.push(back("st:home"));
    return {
      text: list.length
        ? "📢 **Kanallar**\n\nFeed — bot shu kanalga har kuni belgilangan soatda tashlaydigan izlanma (yangiliklar, vakansiyalar…)."
        : "📢 Kanal yo'q.\n\n1. Botni kanalga admin qiling (post yuborish huquqi bilan)\n2. Muhokama uchun kanalga guruh ulang va botni u guruhga ham admin qiling\n3. Shu menyuni qayta oching",
      buttons: rows,
    };
  };

  const channel = (channelId: number): Screen => {
    const c = getChat(db, channelId);
    const feeds = listFeeds(db, channelId);
    const rows: Button[][] = feeds.map((f) => [
      { text: `${f.enabled ? "🟢" : "⚪️"} #${f.id} · ${String(f.hour).padStart(2, "0")}:00 · ${f.topic.slice(0, 30)}`, data: `st:feed:${f.id}` },
    ]);
    rows.push([{ text: "➕ Feed qo'shish", data: `st:addfeed:${channelId}` }]);
    rows.push(back("st:chans"));
    const group = c?.linked_chat_id ? getChat(db, c.linked_chat_id) : null;
    const botInGroup = group && (group.bot_status === "administrator" || group.bot_status === "member");
    const discussion = !c?.linked_chat_id
      ? "yo'q (kanal sozlamalarida guruh ulang)"
      : botInGroup
        ? `${group.title ?? "ulangan"} ✅`
        : "ulangan, lekin bot guruhda yo'q ⚠️ — botni muhokama guruhiga qo'shib admin qiling";
    return { text: `📢 **${c?.title ?? channelId}**\nMuhokama guruhi: ${discussion}`, buttons: rows };
  };

  /** Kanal–guruh bog'lanishi keyin o'zgargan bo'lishi mumkin — Telegram'dan yangilaymiz. */
  const refreshChannel = async (ctx: Context, channelId: number) => {
    const c = getChat(db, channelId);
    if (!c) return;
    const info = await ctx.api.getChat(channelId).catch(() => null);
    if (!info) return;
    upsertChat(db, { ...c, title: info.title ?? c.title, linked_chat_id: info.linked_chat_id ?? null });
    if (info.linked_chat_id) {
      const me = await ctx.api.getChatMember(info.linked_chat_id, ctx.me.id).catch(() => null);
      const g = getChat(db, info.linked_chat_id);
      upsertChat(db, {
        id: info.linked_chat_id,
        type: g?.type ?? "supergroup",
        title: g?.title ?? null,
        username: g?.username ?? null,
        bot_status: me?.status ?? "left",
      });
    }
  };

  const feed = (feedId: number): Screen | null => {
    const f = getFeed(db, feedId);
    if (!f) return null;
    return {
      text:
        `📰 **Feed #${f.id}**\n\n**Mavzu:** ${f.topic}` +
        (isJobsFeed(f.topic)
          ? `\n**Manbalar:** Remotive, We Work Remotely${f.sources ? ` + Telegram: ${f.sources}` : " (Telegram kanallar qo'shilmagan)"}`
          : "") +
        `\nVaqt: har kuni ${String(f.hour).padStart(2, "0")}:00\nHolat: ${f.enabled ? "faol" : "to'xtatilgan"}`,
      buttons: [
        [
          { text: f.enabled ? "⏸ To'xtatish" : "▶️ Yoqish", data: `st:ftog:${f.id}` },
          { text: "🕘 Soat", data: `st:fhour:${f.id}` },
        ],
        [
          { text: "🚀 Hozir post", data: `st:frun:${f.id}` },
          { text: "✏️ Mavzu", data: `st:fedit:${f.id}` },
        ],
        ...(isJobsFeed(f.topic) ? [[{ text: "📡 Telegram manbalar", data: `st:fsrc:${f.id}` }]] : []),
        [{ text: "🗑 O'chirish", data: `st:fdel:${f.id}` }],
        back(`st:chan:${f.channel_id}`),
      ],
    };
  };

  const hourPicker = (feedId: number): Screen => {
    const rows: Button[][] = [];
    for (let h = 6; h < 24; h += 6) {
      rows.push(Array.from({ length: 6 }, (_, i) => ({ text: String(h + i).padStart(2, "0"), data: `st:fsethour:${feedId}:${h + i}` })));
    }
    rows.push(back(`st:feed:${feedId}`));
    return { text: "🕘 Qaysi soatda post qilinsin? (mahalliy vaqt)", buttons: rows };
  };

  // ---------- Handlerlar ----------

  // Ekran matnlari Markdown — Telegram'da HTML bo'lib chiqadi.
  const show = async (ctx: Context, s: Screen) => {
    const view = rich(s.text);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: keyboard(s.buttons) }).catch(ignoreNotModified);
    } else {
      await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: keyboard(s.buttons) });
    }
  };

  const need = (ctx: Context, perm: Perm): boolean => access.has(ctx.from!.id, perm);

  dm.command(["start", "settings", "help"], (ctx) => {
    pending.delete(ctx.from!.id);
    return show(ctx, home(ctx.from!.id));
  });

  dm.callbackQuery(/^st:(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const [action, a, b] = ctx.match[1]!.split(":");
    const n = Number(a);
    await ctx.answerCallbackQuery();

    if (action === "home") return show(ctx, home(userId));

    // Kanallar — "feeds" ruxsati yetarli
    if (["chans", "chan", "addfeed", "feed", "ftog", "fhour", "fsethour", "frun", "fedit", "fdel", "fsrc"].includes(action!)) {
      if (!need(ctx, "feeds")) return show(ctx, home(userId));
      switch (action) {
        case "chans":
          for (const c of listChannels(db)) await refreshChannel(ctx, c.id);
          return show(ctx, channels());
        case "chan":
          await refreshChannel(ctx, n);
          return show(ctx, channel(n));
        case "addfeed":
          pending.set(userId, { kind: "feed_topic", channelId: n });
          return show(ctx, {
            text: "✏️ Feed mavzusini yozing. Masalan:\n\n«Vue, Nuxt, Laravel va Node.js bo'yicha muhim relizlar va xavfsizlik yangiliklari»\n\n«Remote yoki Toshkentdagi Vue/Node.js vakansiyalar, middle/senior»",
            buttons: [back(`st:chan:${n}`)],
          });
        case "feed":
          return show(ctx, feed(n) ?? channels());
        case "ftog": {
          const f = getFeed(db, n);
          if (f) updateFeed(db, n, { enabled: f.enabled ? 0 : 1 });
          return show(ctx, feed(n) ?? channels());
        }
        case "fhour":
          return show(ctx, hourPicker(n));
        case "fsethour":
          updateFeed(db, n, { hour: Number(b) });
          return show(ctx, feed(n) ?? channels());
        case "frun":
          jobs.enqueue(JOB_FEED_POST, { feedId: n, reportChatId: ctx.chat!.id });
          return ctx.reply(`🚀 Feed #${n}: qidiruv boshlandi, tayyor bo'lsa kanalga joylayman.`);
        case "fedit":
          pending.set(userId, { kind: "feed_edit", feedId: n });
          return show(ctx, { text: "✏️ Yangi mavzuni yozing:", buttons: [back(`st:feed:${n}`)] });
        case "fsrc":
          pending.set(userId, { kind: "feed_sources", feedId: n });
          return show(ctx, {
            text:
              "📡 Vakansiyalar olinadigan **Telegram kanallar**ni vergul bilan yozing, masalan:\n\n`@kanal1, @kanal2`\n\n" +
              "Har bir e'lon o'z havolasi va sanasi bilan olinadi. Tozalash uchun `-` yuboring.",
            buttons: [back(`st:feed:${n}`)],
          });
        case "fdel": {
          const f = getFeed(db, n);
          deleteFeed(db, n);
          return show(ctx, f ? channel(f.channel_id) : channels());
        }
      }
    }

    // Qolganlari — faqat admin
    if (!need(ctx, "admin")) return show(ctx, home(userId));
    switch (action) {
      case "stats":
        return show(ctx, stats());
      case "perms":
        return show(ctx, permsCatalog());
      case "users":
        return show(ctx, users(Math.max(0, n || 0)));
      case "user":
        return show(ctx, user(userId, n));
      case "tg": {
        if (b && isPerm(b)) {
          const has = access.granted(n).has(b);
          const ok = has ? access.revoke(userId, n, b) : access.grant(userId, n, b);
          if (!ok) await ctx.reply("Bu ruxsatni o'zgartirishga huquqingiz yo'q.");
        }
        return show(ctx, user(userId, n));
      }
      case "grantid":
        pending.set(userId, { kind: "grant_id" });
        return show(ctx, {
          text: "Foydalanuvchi Telegram ID raqamini yozing.\n\n(ID'ni bilish uchun u odam botga /start yozsin — bot unga ID'sini ko'rsatadi.)",
          buttons: [back("st:users:0")],
        });
      case "work":
        if (a === "unset") settings.set("work_chat_id", "");
        if (a === "unsetchat") settings.set("chat_chat_id", "");
        return show(ctx, work());
      case "cfg":
        return show(ctx, cfg(userId));
      case "lim":
        settings.set("public_daily_limit", String(Math.max(0, settings.publicDailyLimit() + n)));
        return show(ctx, cfg(userId));
      case "disc":
        settings.set("discussion_enabled", settings.get("discussion_enabled") === "0" ? "1" : "0");
        return show(ctx, cfg(userId));
      case "blk": {
        const blocked = access.isBlocked(n);
        if (!access.setBlocked(userId, n, !blocked)) await ctx.reply("Bu odamni bloklash huquqingiz yo'q.");
        return show(ctx, user(userId, n));
      }
    }
  });

  // DM'dagi matn: faqat sozlama kiritish kutilayotgan bo'lsa qabul qilinadi.
  dm.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    const p = pending.get(userId);
    if (!p) {
      if (access.perms(userId).size === 0) return; // begonaga javob yo'q
      return ctx.reply("Bu yerda faqat sozlamalar. Bot bilan suhbat ishchi guruhda bo'ladi.", {
        reply_markup: keyboard([[{ text: "⚙️ Menyu", data: "st:home" }]]),
      });
    }
    pending.delete(userId);
    const text = ctx.message.text.trim();
    if (p.kind === "grant_id") {
      const id = Number(text);
      if (!Number.isInteger(id) || id <= 0 || !access.has(userId, "admin")) return ctx.reply("Noto'g'ri ID.");
      access.touchUser({ id });
      return show(ctx, user(userId, id));
    }
    if (!access.has(userId, "feeds")) return;
    if (p.kind === "feed_sources") {
      const list = text === "-" ? [] : text.split(/[,\s]+/).map((c) => c.replace(/^@|^https?:\/\/t\.me\/(s\/)?/, "").replace(/\/.*$/, "")).filter((c) => /^[A-Za-z0-9_]{4,32}$/.test(c));
      updateFeed(db, p.feedId, { sources: list.map((c) => `@${c}`).join(", ") });
      return show(ctx, feed(p.feedId) ?? channels());
    }
    if (text.length < 5) return ctx.reply("Mavzu juda qisqa.");
    if (p.kind === "feed_topic") {
      const f = addFeed(db, p.channelId, text.slice(0, 500));
      return show(ctx, feed(f.id)!);
    }
    updateFeed(db, p.feedId, { topic: text.slice(0, 500) });
    return show(ctx, feed(p.feedId) ?? channels());
  });

  dm.on(["message:voice", "message:audio"], (ctx) =>
    ctx.reply("Ovozli xabarlarni ishchi guruhga yuboring — bu yerda faqat sozlamalar."),
  );
}
