import type OpenAI from "openai";
import type { Logger } from "../bootstrap/logger.js";

export interface ToolContext {
  /** IANA timezone of the user, when known (x-opod-timezone). */
  timezone?: string;
  signal?: AbortSignal;
  log: Logger;
}

export interface AgentTool {
  /** OpenAI function-tool definition sent to the provider (type: "function"). */
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  /** Executes with raw parsed-JSON args; returns the string for the tool message. */
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

/** Runs one tool call defensively: unknown tool, malformed JSON args, zod-invalid
 *  args, or a thrown execute() all resolve to a short readable error string
 *  (never throws) so the loop can hand failures back to the model in-character. */
export async function executeToolCall(
  tools: AgentTool[],
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  ctx: ToolContext,
): Promise<string> {
  if (ctx.signal?.aborted) throw ctx.signal.reason;
  const name = call.function.name;
  const tool = tools.find((t) => t.definition.function.name === name);
  if (!tool) return `${name}: unknown tool`;

  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return `${name} failed: invalid JSON arguments`;
  }

  try {
    const result = await tool.execute(args, ctx);
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    return result;
  } catch (err) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    return `${name} failed: ${reason(err)}`;
  }
}

/** Bound a tool's network call by both request cancellation and its own deadline. */
export function toolRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** Extracts a short human-readable reason from any thrown value. */
export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
