import { type ChatCompletionRequest, OPOD_HEADERS } from "@opod/protocol";
import type { PlaygroundChatRequest } from "./chat-contract";

/**
 * Sampling is pinned by the caller rather than left to the server default: a
 * mismatched preset shows up as language drift and rambling, and Ollama ships
 * qwen3.6 with two presets mixed together (ollama/ollama#17197).
 *
 * The stack's chat backend is Gemma 4 on mlx_lm.server, whose card gives one
 * preset for every mode. If you point LLM_BASE_URL back at Ollama/qwen3.6, swap
 * these for Qwen's mode-dependent pair — thinking `top_p 0.95 / presence_penalty
 * 0`, non-thinking `top_p 0.80 / presence_penalty 1.5`, both `top_k 20`.
 */
const GEMMA_SAMPLING = { top_p: 0.95, top_k: 64 } as const;

export function toOpodChatRequest(input: PlaygroundChatRequest): ChatCompletionRequest {
  const messages = input.messages
    .map((message) => ({
      content: message.parts
        .filter(
          (part): part is typeof part & { type: "text"; text: string } =>
            part.type === "text" && "text" in part,
        )
        .map((part) => part.text)
        .join(""),
      role: message.role,
    }))
    .filter((message) => message.content.length > 0);

  // opod-agent passes unknown fields straight through to the provider (its
  // request schema is `.passthrough()`), so both spellings of "thinking" reach
  // the model and each server ignores the one that isn't its own: Gemma 4 is
  // switched by the chat template's `enable_thinking` (mlx_lm.server reads
  // `chat_template_kwargs`), Qwen/Ollama by `reasoning_effort`.
  const thinking = input.reasoningEffort !== "none";

  return {
    max_tokens: input.maxTokens,
    messages,
    ...GEMMA_SAMPLING,
    chat_template_kwargs: { enable_thinking: thinking },
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
    stream: true,
    temperature: input.temperature,
  };
}

export function opodChatHeaders(
  input: Pick<
    PlaygroundChatRequest,
    "characterId" | "historyOffset" | "sessionId" | "timezone" | "turnId" | "userId"
  >,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [OPOD_HEADERS.requestId]: requestId,
    // The playground is a debug surface — always ask opod-agent to interleave
    // the tool-activity channel so server tool calls are visible.
    [OPOD_HEADERS.debug]: "1",
  };
  if (input.characterId) headers[OPOD_HEADERS.characterId] = input.characterId;
  headers[OPOD_HEADERS.historyOffset] = String(input.historyOffset);
  if (input.userId) headers[OPOD_HEADERS.userId] = input.userId;
  if (input.sessionId) headers[OPOD_HEADERS.sessionId] = input.sessionId;
  if (input.timezone) headers[OPOD_HEADERS.timezone] = input.timezone;
  if (input.turnId) headers[OPOD_HEADERS.turnId] = input.turnId;
  return headers;
}
