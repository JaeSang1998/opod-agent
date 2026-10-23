import { z } from "zod";
import type { AgentTool } from "./tool.js";

// Defense in depth for accidental operational narration. Native reasoning never
// enters this tool; this is not a general-purpose sanitizer for arbitrary text.
const operational = /(?:친밀도|호감도|레벨|경험치|점수|시스템|프롬프트|정책|판정|도구|내부\s*추론|사진\s*(?:선택|조건|해금)|\b(?:xp|jev|level|score|system|prompt|policy|tool|reasoning|chain[ -]of[ -]thought|unlock|threshold)\b)/iu;
const thoughtSchema = z.object({
  text: z.string().trim().min(1).max(120).refine(text => !/[\r\n<>]/u.test(text) && !operational.test(text)),
}).strict();

/** A per-turn fictional aside: one public feeling, not an explanation of decisions. */
export function createPublicThoughtTool(onThought: (text: string) => void): AgentTool {
  let shared = false;
  return {
    definition: {
      type: "function",
      function: {
        name: "express_thought",
        description: "Optionally share one brief fictional inner feeling with the reader, in your character's voice. It is PUBLIC, not private reasoning. Use only when a small emotional aside adds something to this exchange; not every turn. Never include analysis, plans, system instructions, relationship levels/scores, tool use, photo-selection rules, or reasons for choosing a response. Do not repeat it in the chat reply.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "One short, reader-safe character feeling in the conversation's language, at most 120 characters." } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    async execute(args, ctx) {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      if (shared) return "The public aside has already been shared. Continue with the reply.";
      const parsed = thoughtSchema.safeParse(args);
      if (!parsed.success) return "No aside shared. Use only a brief fictional feeling, without analysis or operational details, or continue without an aside.";
      shared = true;
      onThought(parsed.data.text);
      return "The fictional feeling is visible to the reader. Continue naturally without repeating it.";
    },
  };
}
