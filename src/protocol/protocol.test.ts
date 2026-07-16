import { describe, expect, it } from "vitest";
import { ChatCompletionRequest, ConsolidationRequest, OPOD_HEADERS } from "./index.js";

describe("Agent protocol", () => {
  it("keeps the chat body OpenAI-compatible while accepting unknown standard fields", () => {
    const parsed = ChatCompletionRequest.parse({
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_object" },
    });
    expect(parsed.response_format).toEqual({ type: "json_object" });
  });

  it("requires retry identity, correlation, and policy reason for Consolidation", () => {
    const base = {
      characterId: "luna",
      correlationId: "request-123",
      idempotencyKey: "job-123",
      reason: "memorable-content",
      refreshSummary: true,
      sessionId: "s1",
      turns: [{ role: "user", content: "My cat is Nova." }],
      userId: "u1",
    };

    expect(ConsolidationRequest.parse(base)).toMatchObject(base);
    expect(() => ConsolidationRequest.parse({ ...base, correlationId: undefined })).toThrow();
    expect(() => ConsolidationRequest.parse({ ...base, reason: "sometimes" })).toThrow();
  });

  it("defines every OPOD context header once", () => {
    expect(OPOD_HEADERS).toEqual({
      characterId: "x-opod-character-id",
      requestId: "x-request-id",
      sessionId: "x-opod-session-id",
      timezone: "x-opod-timezone",
      userId: "x-opod-user-id",
    });
  });
});
