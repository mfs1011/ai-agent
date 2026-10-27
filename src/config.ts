import { z } from "zod";

const optionalHour = z
  .string()
  .default("")
  .transform((s) => (s.trim() === "" ? null : Number(s)))
  .pipe(z.number().int().min(0).max(23).nullable());

const schema = z.object({
  BOT_TOKEN: z.string({ error: "BOT_TOKEN kerak" }).min(1, "BOT_TOKEN kerak"),
  OWNER_ID: z.coerce.number({ error: "OWNER_ID kerak" }).int().positive("OWNER_ID kerak"),

  // LLM — Antigravity CLI orqali
  AGY_BIN: z.string().default("agy"),
  AGY_MODEL: z.string().default("gemini-3.8-flash-low"),
  AGY_MODEL_SMART: z.string().default("claude-opus-4-6-thinking"),
  AGY_SANDBOX_DIR: z.string().default("./data/agy-sandbox"),
  // Bot uchun alohida agy profili (HOME): qattiq settings.json bilan. Bo'sh — sizning shaxsiy profilingiz.
  AGY_HOME: z.string().default(""),
  LLM_TIMEOUT_SEC: z.coerce.number().int().positive().default(120),
  AGY_MAX_CONCURRENT: z.coerce.number().int().min(1).max(8).default(2),

  // Ovoz (STT) — agy CLI orqali. Bo'sh = AGY_MODEL
  STT_AGY_MODEL: z.string().default(""),
  STT_VOCABULARY: z.string().default(""),

  DB_PATH: z.string().default("./data/agent.db"),
  TZ_OFFSET_MINUTES: z.coerce.number().int().default(300),
  DEFAULT_CURRENCY: z.string().default("UZS"),

  // O'zini rivojlantirish
  CODER: z.enum(["agy", "claude"]).default("agy"),
  CLAUDE_BIN: z.string().default("claude"),
  CLAUDE_MAX_BUDGET_USD: z.coerce.number().positive().default(3),
  SELF_REPO_PATH: z.string().default(""),
  SELF_BASE_BRANCH: z.string().default("dev"),
  SELF_WORKTREES_DIR: z.string().default("./data/worktrees"),
  IMPLEMENT_TIMEOUT_MIN: z.coerce.number().int().positive().default(40),
  SUGGEST_HOUR: optionalHour,
  SUGGEST_COUNT: z.coerce.number().int().min(1).max(5).default(3),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Konfiguratsiya xato:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
