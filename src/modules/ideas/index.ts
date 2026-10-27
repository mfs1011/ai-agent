import { z } from "zod";
import type { Db } from "../../db.ts";
import type { Config } from "../../config.ts";
import type { ToolModule } from "../../core/agent.ts";
import type { JobQueue } from "../../core/jobs.ts";
import type { Notifier } from "../../core/notify.ts";
import { nextDailyRun } from "../../core/time.ts";
import { defineTool } from "../../core/tools.ts";
import type { CodingAgent, LlmRunner } from "../../llm/types.ts";
import { generateSuggestions, likedButtons, sendSuggestions } from "./generate.ts";
import { implementSuggestion } from "./implement.ts";
import { getSuggestion, listSuggestions, transition } from "./repo.ts";

export const JOB_GENERATE = "ideas.generate";
export const JOB_DAILY = "ideas.daily";
export const JOB_IMPLEMENT = "ideas.implement";

type Deps = {
  db: Db;
  config: Config;
  llm: LlmRunner;
  coder: CodingAgent;
  jobs: JobQueue;
  notifier: Notifier;
  /** Rejali takliflar qayerga boradi: ishchi guruh, bo'lmasa egasining DM'i. */
  targetChat: () => number;
};

export function registerIdeasJobs(deps: Deps) {
  const { db, config, llm, coder, jobs, notifier } = deps;
  const repoPath = config.SELF_REPO_PATH || process.cwd();

  const generate = async (chatId: number) => {
    const list = await generateSuggestions({ db, llm, model: config.AGY_MODEL_SMART, repoPath, count: config.SUGGEST_COUNT });
    await sendSuggestions(notifier, chatId, list);
  };

  jobs.register(JOB_GENERATE, async (job) => {
    const { chatId } = job.payload as { chatId: number };
    await generate(chatId);
  });

  jobs.register(JOB_DAILY, async () => {
    try {
      await generate(deps.targetChat());
    } finally {
      scheduleDaily(deps);
    }
  });

  // Bir vaqtda faqat bitta implement: server kuchsiz va ishlar bir-biriga xalaqit bermasin.
  jobs.register(
    JOB_IMPLEMENT,
    async (job) => {
      const { id, chatId } = job.payload as { id: number; chatId: number };
      await implementSuggestion({ db, config, coder, notifier, chatId }, id);
    },
    1,
  );

  if (!jobs.hasPending(JOB_DAILY)) scheduleDaily(deps);
}

function scheduleDaily(deps: Deps) {
  const hour = deps.config.SUGGEST_HOUR;
  if (hour === null) return;
  deps.jobs.enqueue(JOB_DAILY, {}, { runAt: nextDailyRun(new Date(), hour, deps.config.TZ_OFFSET_MINUTES) });
}

/** Taklifni ishga tushirish. Holat tekshiruvi atomik — ikki marta bosilsa ham bir marta ishlaydi. */
export function startImplement(deps: { db: Db; jobs: JobQueue }, id: number, chatId: number): string {
  const s = getSuggestion(deps.db, id);
  if (!s) return `#${id} topilmadi.`;
  if (!transition(deps.db, id, ["proposed", "liked", "failed"], "queued")) {
    return `#${id} hozir "${s.status}" holatida — qayta ishga tushirib bo'lmaydi.`;
  }
  deps.jobs.enqueue(JOB_IMPLEMENT, { id, chatId });
  return `▶️ #${id} navbatga qo'yildi: ${s.title}\nJarayonni shu chatda ko'rsatib boraman.`;
}

export function ideasTools(deps: { db: Db; jobs: JobQueue }): ToolModule {
  return (ctx) => [
    defineTool({
      name: "ideas_generate",
      description: "Loyihani (shu botni) rivojlantirish bo'yicha yangi takliflar tayyorlashni boshlaydi. Takliflar alohida xabar bo'lib keladi.",
      input: z.object({}),
      run: () => {
        deps.jobs.enqueue(JOB_GENERATE, { chatId: ctx.chatId });
        return "Takliflar tayyorlanmoqda, bir necha daqiqada keladi.";
      },
    }),
    defineTool({
      name: "ideas_list",
      needsResult: true,
      description: "Takliflar ro'yxati holati bo'yicha: liked (yoqqan), proposed (baholanmagan), pr_opened, failed.",
      input: z.object({
        status: z.enum(["proposed", "liked", "disliked", "queued", "running", "pr_opened", "failed"]).optional(),
      }),
      run: (input) =>
        JSON.stringify(
          listSuggestions(deps.db, input.status ? [input.status] : ["proposed", "liked", "running", "pr_opened"]).map((s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            pr_url: s.pr_url,
          })),
        ),
    }),
    defineTool({
      name: "ideas_implement",
      description: "Foydalanuvchi taklifni bajarishni so'rasa chaqiring. O'zi ishga tushirmaydi — tasdiqlash tugmasini yuboradi.",
      input: z.object({ id: z.number().int() }),
      run: (input) => {
        const s = getSuggestion(deps.db, input.id);
        if (!s) return JSON.stringify({ error: `#${input.id} topilmadi` });
        ctx.buttons.push(...likedButtons(s.id));
        return JSON.stringify({ confirm_button_sent: true, title: s.title, status: s.status });
      },
    }),
  ];
}
