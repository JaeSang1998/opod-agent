import { z } from "zod";

/**
 * Minimal zod schemas for the OpenAI Chat Completions surface we accept. We keep
 * the request body 100% standard OpenAI (context rides in headers — docs/adr/0003)
 * and pass unknown fields through to the provider untouched.
 */

export const ChatRole = z.enum(["system", "user", "assistant", "tool", "developer"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z
  .object({
    role: ChatRole,
    content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
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
