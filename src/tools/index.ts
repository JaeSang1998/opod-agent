import type { AgentTool } from "./tool.js";
import { createGetTimeTool } from "./get-time.js";
import { createGetWeatherTool } from "./get-weather.js";
import { createWebSearchTool } from "./web-search.js";

export type { AgentTool, ToolContext } from "./tool.js";
export { executeToolCall } from "./tool.js";

/** The tool set exposed to the model. get_time and get_weather are always
 *  available; web_search is added only when a Tavily key is configured. */
export function buildDefaultTools(opts: {
  webSearch?: { apiKey: string; baseUrl?: string };
}): AgentTool[] {
  const tools = [createGetTimeTool(), createGetWeatherTool()];
  if (opts.webSearch) tools.push(createWebSearchTool(opts.webSearch));
  return tools;
}
