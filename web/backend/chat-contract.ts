import { z } from "zod";

const UITextPart = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const UIPart = z.object({ type: z.string() }).passthrough();
const UIMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.union([UITextPart, UIPart])).default([]),
});

export const PlaygroundChatRequest = z.object({
  characterId: z.string().optional(),
  maxTokens: z.number().int().positive().max(32_768).default(1024),
  messages: z.array(UIMessage).min(1),
  sessionId: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  userId: z.string().optional(),
});
export type PlaygroundChatRequest = z.infer<typeof PlaygroundChatRequest>;
