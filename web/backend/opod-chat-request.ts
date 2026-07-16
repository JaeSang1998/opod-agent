import { type ChatCompletionRequest, OPOD_HEADERS } from "@opod/protocol";
import type { PlaygroundChatRequest } from "./chat-contract";

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

  return {
    max_tokens: input.maxTokens,
    messages,
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
