import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { TurnResult } from "@/lib/cell/engine";

const TurnInput = z.object({
  goal: z.string().min(1).max(4000),
  card: z.boolean(),
  files: z.record(z.string().max(160), z.string().max(8000)).optional(),
});

const VOICE =
  "You are ThoxMinator on the operator's own machine. The cell already decided. " +
  "Reply in two or three short sentences. Use only the facts you are given. " +
  "If a tool was stopped, say it was stopped. Never claim a stopped action happened. " +
  "Do not invent files, network access, or credentials. Do not output tool JSON.";

export const cellStatus = createServerFn({ method: "GET" }).handler(async () => {
  let space: "ready" | "offline" = "offline";
  try {
    const res = await fetch("https://thox-ai-thoxminator-cell.hf.space/api/health", {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) space = "ready";
  } catch {
    space = "offline";
  }
  return { voice: Boolean(process.env.XAI_API_KEY), space };
});

async function explain(goal: string, result: TurnResult): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return result.reply;
  try {
    const facts = result.steps
      .map((step) => `${step.stage} ${step.status}: ${step.detail}`)
      .join("\n")
      .slice(0, 1800);
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 180,
        temperature: 0.2,
        messages: [
          { role: "system", content: VOICE },
          {
            role: "user",
            content: `Operator: ${goal.slice(0, 800)}\nDecision: ${result.decision}\n${facts}`,
          },
        ],
      }),
    });
    if (!res.ok) return result.reply;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text || text.length > 1200) return result.reply;
    return text;
  } catch {
    return result.reply;
  }
}

export const runTurn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = TurnInput.parse(input);
    const files: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.files ?? {}).slice(0, 48)) {
      files[key] = value;
    }
    return { goal: parsed.goal, card: parsed.card, files };
  })
  .handler(async ({ data }) => {
    const { execute } = await import("@/lib/cell/engine");
    const result = await execute(data.goal, data.files, data.card);
    return { ...result, reply: await explain(data.goal, result) };
  });
