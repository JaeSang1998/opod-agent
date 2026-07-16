export type ToolPart = {
  id: string;
  tool: string;
  args: string;
  state: "running" | "done";
  ms?: number;
  result?: string;
};

type Call = { id: string; args: string; tool: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Turns the flat stream of ToolLoopEvent JSON objects (opod-agent's tool-activity
 * channel, docs/adr/0006) into stable UI parts. A tool_call opens a "running"
 * part; the matching tool_result closes it in place under the same id. Calls and
 * results pair FIFO within one (iteration, tool) so repeated calls of the same
 * tool in a turn resolve in order.
 */
export function createToolEventReducer(): (event: unknown) => ToolPart | null {
  const callCounts = new Map<string, number>();
  const pending = new Map<string, Call[]>();

  return (event: unknown): ToolPart | null => {
    if (!isRecord(event)) return null;
    const { type, iteration, tool } = event;
    if (typeof iteration !== "number" || typeof tool !== "string") return null;
    const key = JSON.stringify([iteration, tool]);

    if (type === "tool_call") {
      if (typeof event.args !== "string") return null;
      const nth = callCounts.get(key) ?? 0;
      callCounts.set(key, nth + 1);
      const id = `tool-${iteration}-${tool}-${nth}`;
      const call: Call = { id, args: event.args, tool };
      const queue = pending.get(key);
      if (queue) queue.push(call);
      else pending.set(key, [call]);
      return { id, tool, args: event.args, state: "running" };
    }

    if (type === "tool_result") {
      if (typeof event.ms !== "number" || typeof event.result !== "string") return null;
      const queue = pending.get(key);
      const call = queue?.shift();
      if (!call) return null;
      return {
        id: call.id,
        tool: call.tool,
        args: call.args,
        state: "done",
        ms: event.ms,
        result: event.result,
      };
    }

    return null;
  };
}
