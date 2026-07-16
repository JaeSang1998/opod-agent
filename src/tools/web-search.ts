import { z } from "zod";
import type { AgentTool, ToolContext } from "./tool.js";
import { reason, toolRequestSignal } from "./tool.js";

const Args = z.object({
  query: z.string().min(1),
});

const DEFAULT_BASE_URL = "https://api.tavily.com";
const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 5;
const CONTENT_LIMIT = 300;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

/** Web search via the Tavily API. Requires an API key; fetchFn is injectable so
 *  tests stay offline. */
export function createWebSearchTool(
  cfg: { apiKey: string; baseUrl?: string },
  fetchFn: typeof fetch = fetch,
): AgentTool {
  const baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
  return {
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web for current information. Use for recent events, facts, or anything you may not know.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query.",
            },
          },
          required: ["query"],
        },
      },
    },

    async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
      const { query } = Args.parse(rawArgs);
      try {
        const res = await fetchFn(`${baseUrl}/search`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            query,
            max_results: MAX_RESULTS,
            search_depth: "basic",
          }),
          signal: toolRequestSignal(ctx.signal, TIMEOUT_MS),
        });
        if (!res.ok) return `web_search failed: HTTP ${res.status}`;

        const body = (await res.json()) as { results?: TavilyResult[] };
        const results = body.results ?? [];
        if (results.length === 0) return "No results found.";

        return results.map((r, i) => renderResult(r, i)).join("\n");
      } catch (err) {
        if (ctx.signal?.aborted) throw ctx.signal.reason;
        ctx.log.warn("web_search failed", { query, error: reason(err) });
        return `web_search failed: ${reason(err)}`;
      }
    },
  };
}

function renderResult(r: TavilyResult, index: number): string {
  const content =
    r.content.length > CONTENT_LIMIT ? `${r.content.slice(0, CONTENT_LIMIT)}…` : r.content;
  return `${index + 1}. ${r.title} — ${content} (${r.url})`;
}
