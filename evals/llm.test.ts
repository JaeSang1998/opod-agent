import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAiStructuredLlm } from "./llm.js";

const OutputSchema = z.object({ answer: z.string().min(1) });

describe("OpenAiStructuredLlm", () => {
  it("repairs malformed model JSON, accumulates usage, and falls back from JSON mode", async () => {
    await withFakeOpenAi(
      [completion("not-json"), completion('{"answer":"fixed"}')],
      async ({ baseUrl, requests, fetchImpl }) => {
        const result = await client(baseUrl, 3, fetchImpl).complete({
          schema: OutputSchema,
          system: "system",
          user: "user",
        });

        expect(result.value).toEqual({ answer: "fixed" });
        expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 4, totalTokens: 6 });
        expect(requests[0]?.response_format).toEqual({ type: "json_object" });
        expect(requests[1]?.response_format).toBeUndefined();
        expect(messageText(requests[1])).toContain("previous response was not valid JSON");
      },
    );
  });

  it("keeps JSON mode while repairing a schema-invalid JSON object", async () => {
    await withFakeOpenAi(
      [completion('{"wrong":true}'), completion('{"answer":"valid"}')],
      async ({ baseUrl, requests, fetchImpl }) => {
        const result = await client(baseUrl, 3, fetchImpl).complete({
          schema: OutputSchema,
          system: "system",
          user: "user",
        });

        expect(result.value.answer).toBe("valid");
        expect(requests[1]?.response_format).toEqual({ type: "json_object" });
        expect(messageText(requests[1])).toContain("did not match the required schema");
      },
    );
  });

  it("keeps JSON mode after a transport/rate-limit error", async () => {
    await withFakeOpenAi(
      [apiError(429, "rate limited"), completion('{"answer":"retried"}')],
      async ({ baseUrl, requests, fetchImpl }) => {
        const result = await client(baseUrl, 3, fetchImpl).complete({
          schema: OutputSchema,
          system: "system",
          user: "user",
        });

        expect(result.value.answer).toBe("retried");
        expect(requests).toHaveLength(2);
        expect(requests[1]?.response_format).toEqual({ type: "json_object" });
      },
    );
  });

  it("independently drops unsupported temperature and JSON mode", async () => {
    await withFakeOpenAi(
      [
        apiError(400, "temperature only supports the default value"),
        apiError(400, "response_format json_object is unsupported"),
        completion('{"answer":"portable"}'),
        completion('{"answer":"cached"}'),
      ],
      async ({ baseUrl, requests, fetchImpl }) => {
        const llm = client(baseUrl, 3, fetchImpl);
        const result = await llm.complete({
          schema: OutputSchema,
          system: "system",
          user: "user",
          temperature: 0.35,
        });
        await llm.complete({ schema: OutputSchema, system: "system", user: "user", temperature: 0 });

        expect(result.value.answer).toBe("portable");
        expect(requests[1]?.temperature).toBeUndefined();
        expect(requests[1]?.response_format).toEqual({ type: "json_object" });
        expect(requests[2]?.response_format).toBeUndefined();
        expect(requests[3]?.temperature).toBeUndefined();
      },
    );
  });

  it("fails with the final cause after exhausting malformed responses", async () => {
    await withFakeOpenAi(
      [completion("bad-one"), completion("bad-two")],
      async ({ baseUrl, requests, fetchImpl }) => {
        const llm = client(baseUrl, 2, fetchImpl);
        let caught: unknown;
        try {
          await llm.complete({ schema: OutputSchema, system: "system", user: "user" });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe("Structured completion failed after 2 attempts");
        expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
        expect(requests).toHaveLength(2);
      },
    );
  });
});

function client(baseUrl: string, maxAttempts = 3, fetchImpl?: typeof fetch): OpenAiStructuredLlm {
  return new OpenAiStructuredLlm({
    baseUrl,
    apiKey: "test-key",
    model: "judge-test",
    timeoutMs: 2_000,
    maxAttempts,
    fetch: fetchImpl,
  });
}

interface FakeResponse {
  status: number;
  body: Record<string, unknown>;
}

function completion(content: string): FakeResponse {
  return {
    status: 200,
    body: {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "judge-test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  };
}

function apiError(status: number, message: string): FakeResponse {
  return {
    status,
    body: { error: { message, type: "invalid_request_error", code: null } },
  };
}

async function withFakeOpenAi(
  responses: FakeResponse[],
  operation: (context: {
    baseUrl: string;
    requests: Array<Record<string, unknown>>;
    fetchImpl: typeof fetch;
  }) => Promise<void>,
): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const fixture = responses[cursor] ?? responses.at(-1);
    cursor += 1;
    if (!fixture) throw new Error("fake server has no response fixture");
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    });
  };
  await operation({ baseUrl: "http://fake.openai.local/v1", requests, fetchImpl });
}

function messageText(request: Record<string, unknown> | undefined): string {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const last = messages.at(-1);
  return typeof last === "object" && last !== null && "content" in last
    ? String(last.content)
    : "";
}
