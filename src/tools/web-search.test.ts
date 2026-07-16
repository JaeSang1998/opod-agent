import { describe, it, expect, vi } from "vitest";
import { createWebSearchTool } from "./web-search.js";
import { noopLogger } from "../bootstrap/logger.js";
import type { ToolContext } from "./tool.js";

const ctx: ToolContext = { log: noopLogger };

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe("createWebSearchTool", () => {
  it("sends the query with auth + body and renders numbered results", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({
        results: [
          { title: "First", url: "https://a.test", content: "alpha" },
          { title: "Second", url: "https://b.test", content: "beta" },
        ],
      }),
    );
    const tool = createWebSearchTool({ apiKey: "secret-key" }, fetchFn as unknown as typeof fetch);

    const out = await tool.execute({ query: "opod agent" }, ctx);

    expect(out).toBe(
      "1. First — alpha (https://a.test)\n2. Second — beta (https://b.test)",
    );

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.tavily.com/search");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ query: "opod agent", max_results: 5, search_depth: "basic" });
  });

  it("honors a custom baseUrl", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ results: [] }));
    const tool = createWebSearchTool(
      { apiKey: "k", baseUrl: "https://tavily.internal" },
      fetchFn as unknown as typeof fetch,
    );

    await tool.execute({ query: "x" }, ctx);

    expect(String(fetchFn.mock.calls[0]![0])).toBe("https://tavily.internal/search");
  });

  it("returns 'No results found.' for an empty result set", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ results: [] }));
    const tool = createWebSearchTool({ apiKey: "k" }, fetchFn as unknown as typeof fetch);

    const out = await tool.execute({ query: "x" }, ctx);

    expect(out).toBe("No results found.");
  });

  it("returns an error string including the status on a non-2xx response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 401));
    const tool = createWebSearchTool({ apiKey: "k" }, fetchFn as unknown as typeof fetch);

    const out = await tool.execute({ query: "x" }, ctx);

    expect(out).toContain("web_search failed");
    expect(out).toContain("401");
  });
});
