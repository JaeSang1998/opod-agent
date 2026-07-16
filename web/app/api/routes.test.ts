import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPOD_HEADERS } from "@opod/protocol";
import { fetchOpod } from "@/backend/opod";
import { POST as chatPost } from "./chat/route";
import { POST as consolidatePost } from "./consolidate/route";

vi.mock("@/backend/opod", () => ({ fetchOpod: vi.fn() }));

const fetchOpodMock = vi.mocked(fetchOpod);

beforeEach(() => {
  fetchOpodMock.mockReset();
});

describe("Next route contracts", () => {
  it("rejects an invalid chat payload before calling upstream", async () => {
    const response = await chatPost(
      new Request("http://playground.test/api/chat", {
        body: JSON.stringify({ messages: [] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(fetchOpodMock).not.toHaveBeenCalled();
  });

  it("validates and correlates the chat proxy request even when upstream rejects it", async () => {
    fetchOpodMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const response = await chatPost(
      new Request("http://playground.test/api/chat", {
        body: JSON.stringify({
          characterId: "luna",
          messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
          userId: "u1",
        }),
        headers: { "content-type": "application/json", [OPOD_HEADERS.requestId]: "web-trace-1" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get(OPOD_HEADERS.requestId)).toBe("web-trace-1");
    expect(fetchOpodMock).toHaveBeenCalledWith(
      "/v1/chat/completions",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("forwards the consolidation contract and echoes its correlation id", async () => {
    fetchOpodMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const response = await consolidatePost(
      new Request("http://playground.test/api/consolidate", {
        body: JSON.stringify({
          characterId: "luna",
          correlationId: "worker-trace-1",
          idempotencyKey: "job-1",
          reason: "manual",
          refreshSummary: true,
          sessionId: "s1",
          turns: [{ role: "user", content: "hello" }],
          userId: "u1",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(OPOD_HEADERS.requestId)).toBe("worker-trace-1");
    expect(fetchOpodMock).toHaveBeenCalledWith(
      "/memory/consolidate",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("maps a thrown upstream connection error to a safe 502", async () => {
    fetchOpodMock.mockRejectedValue(new Error("secret internal upstream address"));
    const response = await chatPost(
      new Request("http://playground.test/api/chat", {
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe("opod-agent unavailable");
  });

  it("translates upstream reasoning and content SSE into an AI UI stream", async () => {
    const frames = [
      { choices: [{ delta: { reasoning: "thinking" } }] },
      { choices: [{ delta: { content: "answer" } }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
    fetchOpodMock.mockResolvedValue(
      new Response(`${frames}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
    );

    const response = await chatPost(
      new Request("http://playground.test/api/chat", {
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(stream).toContain("thinking");
    expect(stream).toContain("answer");
  });

  it("maps a thrown consolidation connection error to a safe 502", async () => {
    fetchOpodMock.mockRejectedValue(new Error("secret internal upstream address"));
    const response = await consolidatePost(
      new Request("http://playground.test/api/consolidate", {
        body: JSON.stringify({
          characterId: "luna",
          correlationId: "worker-trace-2",
          idempotencyKey: "job-2",
          reason: "manual",
          refreshSummary: false,
          sessionId: "s1",
          turns: [{ role: "user", content: "hello" }],
          userId: "u1",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get(OPOD_HEADERS.requestId)).toBe("worker-trace-2");
    await expect(response.text()).resolves.toBe("opod-agent unavailable");
  });

  it("maps a rejected consolidation response body to a safe 502", async () => {
    fetchOpodMock.mockResolvedValue({
      status: 200,
      text: vi.fn().mockRejectedValue(new Error("body read failed")),
    } as unknown as Response);
    const response = await consolidatePost(
      new Request("http://playground.test/api/consolidate", {
        body: JSON.stringify({
          characterId: "luna",
          correlationId: "worker-trace-3",
          idempotencyKey: "job-3",
          reason: "manual",
          refreshSummary: false,
          sessionId: "s1",
          turns: [{ role: "user", content: "hello" }],
          userId: "u1",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get(OPOD_HEADERS.requestId)).toBe("worker-trace-3");
  });

  it.each([
    ["malformed frame", "data: not-json\n\ndata: [DONE]\n\n"],
    ["EOF before done", `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`],
  ])("surfaces an upstream SSE protocol error for %s", async (_label, frames) => {
    fetchOpodMock.mockResolvedValue(
      new Response(frames, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
    );

    const response = await chatPost(
      new Request("http://playground.test/api/chat", {
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("stream failed");
  });
});
