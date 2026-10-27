import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { Access } from "./core/access.ts";
import { Agent } from "./core/agent.ts";
import { JobQueue } from "./core/jobs.ts";
import { ChatLog, InFlight, Settings, UpdateGuard, Usage } from "./core/state.ts";
import { AgyCoder, AgyRunner } from "./llm/agy.ts";
import { ClaudeCoder } from "./llm/claude.ts";
import { probeFileIsolation } from "./llm/probe.ts";
import type { CodingAgent } from "./llm/types.ts";
import { createStt } from "./stt/index.ts";
import { createNotifier, setupBot } from "./bot/index.ts";
import { registerFeedJobs } from "./modules/feeds/index.ts";
import { financeTools } from "./modules/finance/tools.ts";
import { RateProvider } from "./modules/finance/rates.ts";
import { registerFinanceJobs } from "./modules/finance/jobs.ts";
import { ideasTools, registerIdeasJobs } from "./modules/ideas/index.ts";
import { mediaTools } from "./modules/media/images.ts";
import { memoryTools } from "./modules/memory/index.ts";
import { errMessage, log } from "./log.ts";

async function main() {
  const config = loadConfig();
  const db = openDb(config.DB_PATH);
  const bot = new Bot(config.BOT_TOKEN);
  const notifier = createNotifier(bot);
  // Update'lar parallel ishlanadi: bitta chatdagi xabarlar navbat bilan (tartib saqlanadi),
  // tugma bosilishlari esa darhol — bot javob yozayotganda ham "⏹ To'xtatish" ishlaydi.
  bot.use(sequentialize((ctx) => (ctx.callbackQuery ? undefined : ctx.chat?.id.toString())));
  const jobs = new JobQueue(db);
  const access = new Access(db, config.OWNER_ID);
  const settings = new Settings(db);
  const chatLog = new ChatLog(db);
  const usage = new Usage(db);
  const updates = new UpdateGuard(db);
  updates.prune();
  const inFlight = new InFlight();
  const rates = new RateProvider(settings, fetch, db);
  // Kursi hali saqlanmagan eski valyuta yozuvlarini o'z kunidagi kurs bilan to'ldirish
  void rates.fillMissing().then((n) => n && log.info("fx rates backfilled", { count: n }));

  const llm = new AgyRunner({
    bin: config.AGY_BIN,
    model: config.AGY_MODEL,
    sandboxDir: config.AGY_SANDBOX_DIR,
    timeoutMs: config.LLM_TIMEOUT_SEC * 1000,
    maxConcurrent: config.AGY_MAX_CONCURRENT,
    home: config.AGY_HOME || undefined,
  });
  const coder: CodingAgent =
    config.CODER === "claude"
      ? new ClaudeCoder(config.CLAUDE_BIN, config.CLAUDE_MAX_BUDGET_USD)
      : new AgyCoder(llm, config.AGY_MODEL_SMART);

  const agent = new Agent({
    llm,
    tzOffsetMin: config.TZ_OFFSET_MINUTES,
    modules: [
      {
        perm: "finance",
        tools: financeTools(db, { tzOffsetMin: config.TZ_OFFSET_MINUTES, defaultCurrency: config.DEFAULT_CURRENCY, rates }),
      },
      { perm: "ideas", tools: ideasTools({ db, jobs }) },
      { perm: "agent", tools: memoryTools(db) },
      { perm: "agent", tools: mediaTools({ llm, baseDir: resolve(config.AGY_SANDBOX_DIR, "images") }) },
    ],
  });

  // Muhokama (begona odamlar) xavfsizlik tekshiruvidan o'tmaguncha yopiq.
  const safety = { discussionOpen: false };

  registerIdeasJobs({ db, config, llm, coder, jobs, notifier, targetChat: () => settings.workChatId() ?? config.OWNER_ID });
  registerFeedJobs({ db, config, llm, jobs, notifier, alertChat: () => settings.workChatId() });
  registerFinanceJobs({ db, config, jobs, notifier, targetChat: () => settings.workChatId() });
  const stt = createStt(config, llm);
  setupBot(bot, { config, db, agent, stt, jobs, access, settings, chatLog, usage, notifier, safety, updates, inFlight, rates });

  await bot.api.setMyCommands([{ command: "settings", description: "Sozlamalar va statistika" }], {
    scope: { type: "all_private_chats" },
  });
  await bot.api.setMyCommands(
    [
      { command: "ask", description: "Botdan so'rash" },
      { command: "report", description: "Oy hisoboti (ishchi guruh)" },
      { command: "majburiy", description: "Majburiy to'lovlar va prognoz" },
      { command: "ideas", description: "Rivojlantirish takliflari (ishchi guruh)" },
      { command: "liked", description: "Yoqqan takliflar (ishchi guruh)" },
    ],
    { scope: { type: "all_group_chats" } },
  );

  jobs.start();

  void probeFileIsolation(llm, dirname(resolve(config.DB_PATH)))
    .then(async (r) => {
      safety.discussionOpen = r.isolated;
      log.info("agy isolation probe", r);
      // Ogohlantirish faqat holat o'zgarganda (har restartda emas).
      const prev = settings.get("agy_isolation");
      settings.set("agy_isolation", r.isolated ? "isolated" : "leaky");
      if (!r.isolated && prev !== "leaky") {
        await notifier.send(
          config.OWNER_ID,
          `⚠️ Xavfsizlik: ${r.detail}.\nOmmaviy muhokama o'chirildi (siz uchun ishlaydi).\n\n` +
            `Tuzatish: agy settings.json'da "allowNonWorkspaceAccess": false qiling (deploy/agy-settings.json namunasi) va botni qayta ishga tushiring.`,
        );
      }
    })
    .catch((e) => log.error("agy isolation probe failed", { error: errMessage(e) }));

  let runner: ReturnType<typeof run> | null = null;
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal, inFlight: inFlight.size });
    // Yangi update qabul qilinmaydi; boshlanganlari oxiriga yetkaziladi (agy javobi ~10-20 s).
    if (runner?.isRunning()) await runner.stop();
    if (!(await inFlight.idle(90_000))) log.warn("shutdown: in-flight updates did not finish", { left: inFlight.size });
    await jobs.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.init();
  log.info("bot started", { username: bot.botInfo.username });
  runner = run(bot, {
    runner: { fetch: { allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "channel_post"] } },
  });
  await runner.task();
}

main().catch((e) => {
  log.error("fatal", { error: errMessage(e) });
  process.exit(1);
});
