import type OpenAI from "openai";
import type { LLMProvider } from "../provider/llm-provider.js";

/** Deterministic LLMProvider for tests. Records calls; returns canned output. */
export class FakeProvider implements LLMProvider {
  readonly defaultModel = "fake-model";
  readonly chatCalls: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[] = [];
  readonly embedCalls: string[][] = [];

  constructor(
    private readonly reply = "Hello from the stars.",
    private readonly observationsJson = "[]",
  ) {}

  async chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    this.chatCalls.push(req);
    const content = this.respondTo(String(req.messages[0]?.content ?? ""));
    return {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 0,
      model: req.model,
      choices: [
        { index: 0, message: { role: "assistant", content, refusal: null }, finish_reason: "stop", logprobs: null },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as OpenAI.Chat.Completions.ChatCompletion;
  }

  /** Route by the system-prompt intent so each consolidation step gets a valid reply. */
  private respondTo(system: string): string {
    if (system.includes("Extract durable Observations")) return this.observationsJson;
    if (system.includes("salient high-level questions")) return "What does the user care about?";
    if (system.includes("high-level Reflections")) {
      return "The user values companionship (because of 1)";
    }
    if (system.includes("compact Core Memory")) return "Nova the cat's owner; enjoys late chats.";
    if (system.includes("running summary")) return "They introduced their cat Nova.";
    return this.reply;
  }

  async chatStream(): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    const reply = this.reply;
    async function* gen() {
      for (const word of reply.split(" ")) {
        yield {
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake-model",
          choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
        } as OpenAI.Chat.Completions.ChatCompletionChunk;
      }
    }
    return gen();
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls.push(texts);
    // Deterministic, reasonably discriminative embedding: signed hashed buckets,
    // so distinct texts land far apart in cosine space (unlike a naive all-positive
    // sum, which would make everything look ~identical and trip similarity dedup).
    const dim = 32;
    return texts.map((t) => {
      const v = new Array(dim).fill(0);
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        const idx = (c * 31 + i) % dim;
        v[idx] += (c % 2 === 0 ? 1 : -1) * (1 + (c % 5));
      }
      return v;
    });
  }
}
