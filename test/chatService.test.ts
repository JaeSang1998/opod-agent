import { describe, it, expect } from "vitest";
import { ChatService } from "../src/core/chatService.js";
import { StubPersonaStore } from "../src/persona/stub/StubPersonaStore.js";
import { StubMemoryStore } from "../src/memory/stub/StubMemoryStore.js";
import { StubJobQueue } from "../src/queue/stub/StubJobQueue.js";
import { FakeProvider } from "./fakeProvider.js";
import type { ChatCompletionRequest } from "../src/openai/types.js";

const config = {
  retrieveTopK: 6,
  weights: { recency: 1, importance: 1, relevance: 1 },
  recencyDecay: 0.99,
};

function makeService(provider = new FakeProvider()) {
  const queue = new StubJobQueue();
  const service = new ChatService(
    provider,
    new StubPersonaStore(),
    new StubMemoryStore(),
    queue,
    config,
  );
  return { service, queue, provider };
}

const body: ChatCompletionRequest = {
  messages: [{ role: "user", content: "My cat is named Nova." }],
};

describe("ChatService.prepare", () => {
  it("prepends a persona system prompt when a character is set", async () => {
    const { service } = makeService();
    const prepared = await service.prepare(body, { characterId: "luna" });
    const first = prepared.request.messages[0];
    expect(first?.role).toBe("system");
    expect(String(first?.content)).toContain("You are Luna.");
  });

  it("degrades to a plain proxy when no character header is present", async () => {
    const { service } = makeService();
    const prepared = await service.prepare(body, {});
    // No system prompt injected — messages untouched.
    expect(prepared.request.messages[0]?.role).toBe("user");
  });

  it("enqueues a memory-update job after a personalized turn", async () => {
    const { service, queue } = makeService();
    const prepared = await service.prepare(body, {
      characterId: "luna",
      userId: "u1",
      sessionId: "s1",
    });
    await prepared.postTurn("What a great name!");
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.sessionId).toBe("s1");
  });

  it("does not enqueue when identity is incomplete", async () => {
    const { service, queue } = makeService();
    const prepared = await service.prepare(body, { characterId: "luna" });
    await prepared.postTurn("reply");
    expect(queue.enqueued).toHaveLength(0);
  });
});
