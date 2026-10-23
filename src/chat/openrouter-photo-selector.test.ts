import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getMockPhotoCatalog } from "./photo-catalog.js";
import { OpenRouterPhotoSelector } from "./openrouter-photo-selector.js";
import type { PhotoSelectorInput } from "./photo-selector.js";

const input: PhotoSelectorInput = {
  persona: "Luna likes quiet coffee breaks.",
  recentTurns: [{ role: "user", content: "Shall we take a coffee break?" }],
  intent: "Share a coffee scene.",
  eligiblePhotos: getMockPhotoCatalog("luna").slice(0, 2),
};
function responseFor(choice = "scene_0") {
  return { answers: { photo: { type: "choice", choice, confidence: 0.8,
    probabilities: { none: choice === "none" ? 0.8 : 0.1, scene_0: choice === "scene_0" ? 0.8 : 0.1, scene_1: choice === "scene_1" ? 0.8 : 0.1 },
  } } };
}

describe("OpenRouterPhotoSelector", () => {
  it("sends a real Decisions choice with none and maps the answer to server-owned media", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responseFor()));
    const selector = new OpenRouterPhotoSelector({ apiKey: "test-key", baseUrl: "http://localhost:9000/", model: "typesafe/jev-1.13", fetchImplementation: transport });
    expect(await selector.select(input)).toBe("mock:luna:coffee");
    const [url, request] = transport.mock.calls[0]!;
    expect(url).toBe("http://localhost:9000/api/alpha/decisions");
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.state).toEqual({ persona: input.persona, recentTurns: input.recentTurns, intent: input.intent });
    expect(Object.keys(body.questions.photo.criteria)).toEqual(["none", "scene_0", "scene_1"]);
    expect(String(request?.body)).not.toContain(input.eligiblePhotos[0]!.url);
    expect(String(request?.body)).not.toContain(input.eligiblePhotos[0]!.id);
    expect(body).not.toHaveProperty("messages");
  });

  it("honors none without a fallback photo", async () => {
    const selector = new OpenRouterPhotoSelector({ apiKey: "key", fetchImplementation: async () => Response.json(responseFor("none")) });
    expect(await selector.select(input)).toBeNull();
  });

  it.each([
    { choice: "https://attacker.example/image.jpg" },
    { choice: "mock:luna:coffee" },
    { choice: "scene_7" },
    { url: "https://attacker.example/image.jpg" },
    { probabilities: { none: 0.1, scene_0: 0.8, scene_1: 0.1, injected: 0 } },
    { probabilities: { none: 0.1, scene_0: 0.8 } },
    { probabilities: { none: 0.1, scene_0: 0.1, scene_1: 0.8 } },
    { probabilities: { none: 0, scene_0: 0.2, scene_1: 0 } },
  ])("rejects unbound or invalid decisions without exposing media", async patch => {
    const raw = responseFor();
    const selector = new OpenRouterPhotoSelector({ apiKey: "key", fetchImplementation: async () => Response.json({ answers: { photo: { ...raw.answers.photo, ...patch } } }) });
    expect(await selector.select(input)).toBeNull();
  });

  it.each([401, 429, 500])("returns no photo on HTTP %s", async status => {
    const selector = new OpenRouterPhotoSelector({ apiKey: "secret", fetchImplementation: async () => new Response("private details", { status }) });
    expect(await selector.select(input)).toBeNull();
  });

  it("returns no photo on transport errors or malformed JSON", async () => {
    const failing = new OpenRouterPhotoSelector({ apiKey: "secret", fetchImplementation: async () => { throw new Error("private details"); } });
    const malformed = new OpenRouterPhotoSelector({ apiKey: "secret", fetchImplementation: async () => new Response("not JSON") });
    expect(await failing.select(input)).toBeNull();
    expect(await malformed.select(input)).toBeNull();
  });

  it("enforces its deadline even when response body decoding ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response);
      const result = new OpenRouterPhotoSelector({ apiKey: "key", timeoutMs: 100, fetchImplementation: transport }).select(input);
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toBeNull();
      expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("gives secret files priority, including empty/unreadable secrets, without falling back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opod-photo-key-"));
    const path = join(directory, "key");
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responseFor()));
    try {
      writeFileSync(path, "file-key\n", { mode: 0o600 });
      const options = { apiKey: "env-key", apiKeyFile: path, fetchImplementation: transport };
      expect(await new OpenRouterPhotoSelector(options).select(input)).toBe("mock:luna:coffee");
      expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer file-key");
      writeFileSync(path, "\n");
      expect(await new OpenRouterPhotoSelector(options).select(input)).toBeNull();
      expect(await new OpenRouterPhotoSelector({ ...options, apiKeyFile: join(directory, "missing") }).select(input)).toBeNull();
      expect(transport).toHaveBeenCalledOnce();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not request an unavailable, empty, or misconfigured catalog", async () => {
    const transport = vi.fn<typeof fetch>();
    expect(await new OpenRouterPhotoSelector({ fetchImplementation: transport }).select(input)).toBeNull();
    expect(await new OpenRouterPhotoSelector({ apiKey: "key", baseUrl: "https://openrouter.ai/api/v1", fetchImplementation: transport }).select(input)).toBeNull();
    expect(await new OpenRouterPhotoSelector({ apiKey: "key", fetchImplementation: transport }).select({ ...input, eligiblePhotos: [] })).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
});
