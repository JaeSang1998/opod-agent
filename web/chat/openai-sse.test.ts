import { describe, expect, it } from "vitest";
import { readSSEData } from "./openai-sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function byteStreamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of readSSEData(stream)) values.push(value);
  return values;
}

describe("readSSEData", () => {
  it("parses frames split across chunks and CRLF separators", async () => {
    const values = await collect(
      streamOf(["data: {\"a\":", "1}\r\n\r\ndata: [DONE]", "\r\n\r\n"]),
    );
    expect(values).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("flushes a final event without a trailing blank line", async () => {
    expect(await collect(streamOf(["data: final"]))).toEqual(["final"]);
  });

  it("joins multiple data fields according to the SSE format", async () => {
    expect(await collect(streamOf(["data: line one\ndata: line two\n\n"]))).toEqual([
      "line one\nline two",
    ]);
  });

  it("parses the same UTF-8 event at every possible byte split", async () => {
    const bytes = new TextEncoder().encode("data: {\"text\":\"안녕 🌙\"}\n\n");
    for (let split = 1; split < bytes.length; split += 1) {
      const values = await collect(byteStreamOf([bytes.slice(0, split), bytes.slice(split)]));
      expect(values, `split at byte ${split}`).toEqual(['{"text":"안녕 🌙"}']);
    }
  });

  it("cancels a pending upstream read when the request is aborted", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const iterator = readSSEData(stream, controller.signal);
    const pending = iterator.next();

    controller.abort(new DOMException("client disconnected", "AbortError"));

    await expect(pending).resolves.toMatchObject({ done: true });
    expect(cancelled).toBe(true);
  });
});
