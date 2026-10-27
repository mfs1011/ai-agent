import { z } from "zod";

// Agent tool'i: nomi, tavsifi, argument sxemasi (Zod) va bajaruvchi funksiya.
// Model tool'ni chaqirmaydi — JSON'da "shu tool'ni shu argumentlar bilan" deydi, biz tekshirib bajaramiz.

export type ToolDef = {
  name: string;
  description: string;
  input: z.ZodType;
  /** true — model natijani ko'rib javob yozishi kerak (hisobot, ro'yxat). false — yozish amali, natija oldindan ma'lum. */
  needsResult?: boolean;
  /** Argumentlar `input` bilan tekshirilgandan keyin chaqiriladi. Tip xavfsizligi defineTool'da. */
  run: (args: any) => string | Promise<string>;
};

export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  input: S;
  needsResult?: boolean;
  run: (args: z.infer<S>) => string | Promise<string>;
}): ToolDef {
  return def;
}

/** Prompt uchun tool'lar ro'yxati: nom, tavsif va argumentlarning JSON Schema'si. */
export function renderToolCatalog(tools: ToolDef[]): string {
  return tools
    .map((t) => {
      const { $schema: _s, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
      return `### ${t.name}\n${t.description}\nArgumentlar: ${JSON.stringify(schema)}`;
    })
    .join("\n\n");
}

export type ActionResult = { tool: string; args: unknown; ok: boolean; result: string; needsResult: boolean };

/** Model so'ragan amalni bajaradi: tool mavjudmi, argumentlar sxemaga mosmi — tekshiriladi. */
export async function executeAction(tools: ToolDef[], tool: string, argsJson: string): Promise<ActionResult> {
  const def = tools.find((t) => t.name === tool);
  if (!def) return { tool, args: argsJson, ok: false, needsResult: true, result: `Bunday tool yo'q yoki ruxsat yo'q: ${tool}` };
  let raw: unknown;
  try {
    raw = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return { tool, args: argsJson, ok: false, needsResult: true, result: "args_json yaroqli JSON emas" };
  }
  const parsed = def.input.safeParse(raw);
  if (!parsed.success) {
    return { tool, args: raw, ok: false, needsResult: true, result: `Argumentlar xato: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  try {
    const result = await def.run(parsed.data);
    // Tool amalni bajarmagan bo'lsa (masalan dublikat) — model natijani ko'rib javob yozishi kerak
    const notDone = result.includes('"not_saved":true');
    return { tool, args: parsed.data, ok: !notDone, needsResult: notDone || (def.needsResult ?? false), result };
  } catch (e) {
    return { tool, args: parsed.data, ok: false, needsResult: true, result: e instanceof Error ? e.message : String(e) };
  }
}
