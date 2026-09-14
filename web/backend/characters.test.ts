import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SERVICE_BACKEND_URL", "https://service.example/");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("playground character source", () => {
  it("preserves backend identity and order without confusing public handles with persona IDs", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json([
      { id: "character-1", publicId: "public-one", displayName: "First" },
      { id: "character-2", displayName: "Second" },
      null,
      { id: 3, displayName: "Invalid identity" },
      { id: "character-4", displayName: null },
      { id: "character-5", publicId: "public-five", displayName: "Fifth" },
    ]));
    vi.stubGlobal("fetch", fetch);
    const { listCharacters } = await import("./characters");

    await expect(listCharacters()).resolves.toEqual([
      { id: "character-1", publicId: "public-one", displayName: "First" },
      { id: "character-2", publicId: "character-2", displayName: "Second" },
      { id: "character-5", publicId: "public-five", displayName: "Fifth" },
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://service.example/characters");
  });

  it("keeps the manual character entry available without a configured listing service", async () => {
    vi.stubEnv("SERVICE_BACKEND_URL", undefined);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { listCharacters } = await import("./characters");

    await expect(listCharacters()).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["server error", "invalid shape", "network error"])("keeps listing failure optional: %s", async (failure) => {
    const fetch = vi.fn();
    if (failure === "network error") fetch.mockRejectedValue(new Error("connection failed"));
    else fetch.mockResolvedValue(failure === "server error"
      ? new Response("unavailable", { status: 503 })
      : Response.json({ error: "not a character list" }));
    vi.stubGlobal("fetch", fetch);
    const { listCharacters } = await import("./characters");

    await expect(listCharacters()).resolves.toEqual([]);
  });
});
