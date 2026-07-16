import { z } from "zod";

/** OpenAI Chat Completions wire contract. OPOD context always rides in headers. */
const ChatRole = z.enum(["system", "user", "assistant", "tool", "developer"]);

export const ChatMessage = z
  .object({
    role: ChatRole,
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    name: z.string().optional(),
  })
  .passthrough();
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatCompletionRequest = z
  .object({
    model: z.string().optional(),
    messages: z.array(ChatMessage).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;
