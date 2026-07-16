import { describe, expect, it } from "vitest";
import { ChatCompletionRequest, OPOD_HEADERS } from "@opod/protocol";
import { PlaygroundChatRequest } from "./chat-contract";
import { opodChatHeaders, toOpodChatRequest } from "./opod-chat-request";

describe("opod chat request bridge", () => {
  it("maps UI text into the shared OpenAI-compatible contract", () => {
    const input = PlaygroundChatRequest.parse({
      characterId: "luna",
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "reasoning", text: "private chain" },
            { type: "text", text: "Visible answer" },
          ],
        },
      ],
      sessionId: "s1",
      turnId: "turn-1",
      userId: "u1",
    });

    const request = toOpodChatRequest(input);

    expect(ChatCompletionRequest.parse(request)).toEqual(request);
    expect(request.messages).toEqual([{ role: "assistant", content: "Visible answer" }]);
  });

  it("uses the shared identity and correlation header names", () => {
    const input = PlaygroundChatRequest.parse({
      characterId: "luna",
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      sessionId: "s1",
      historyOffset: 4,
      turnId: "turn-2",
      userId: "u1",
    });

    expect(opodChatHeaders(input, "trace-1")).toMatchObject({
      [OPOD_HEADERS.characterId]: "luna",
      [OPOD_HEADERS.historyOffset]: "4",
      [OPOD_HEADERS.requestId]: "trace-1",
      [OPOD_HEADERS.sessionId]: "s1",
      [OPOD_HEADERS.turnId]: "turn-2",
      [OPOD_HEADERS.userId]: "u1",
    });
  });
});
