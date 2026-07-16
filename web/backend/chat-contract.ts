import { z } from "zod";

const UITextPart = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const UIPart = z.object({ type: z.string() }).passthrough();
const UIMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.union([UITextPart, UIPart])).default([]),
});

export const PlaygroundChatRequest = z.object({
  characterId: z.string().optional(),
  historyOffset: z.number().int().nonnegative().default(0),
  maxTokens: z.number().int().positive().max(32_768).default(1024),
  messages: z.array(UIMessage).min(1),
  sessionId: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  timezone: z.string().min(1).max(64).optional(),
  turnId: z.string().min(1).max(256).optional(),
  userId: z.string().optional(),
}).superRefine((request, ctx) => {
  if (request.characterId && request.userId && request.sessionId && !request.turnId) {
    ctx.addIssue({
      code: "custom",
      message: "turnId is required for personalized learning",
      path: ["turnId"],
    });
  }
});
export type PlaygroundChatRequest = z.infer<typeof PlaygroundChatRequest>;
