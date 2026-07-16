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
 * results reconcile by the Provider's call id, so parallel calls of one tool may
 * finish in any order without attaching a result to the wrong arguments.
 */
export function createToolEventReducer(): (event: unknown) => ToolPart | null {
  const pending = new Map<string, Call>();

  return (event: unknown): ToolPart | null => {
    if (!isRecord(event)) return null;
    const { type, callId, iteration, tool } = event;
    if (
      typeof callId !== "string" ||
      typeof iteration !== "number" ||
      typeof tool !== "string"
    ) {
      return null;
    }
    const key = JSON.stringify([iteration, callId]);

    if (type === "tool_call") {
      if (typeof event.args !== "string") return null;
      const id = `tool-${iteration}-${callId}`;
      const call: Call = { id, args: event.args, tool };
      pending.set(key, call);
      return { id, tool, args: event.args, state: "running" };
    }

    if (type === "tool_result") {
      if (typeof event.ms !== "number" || typeof event.result !== "string") return null;
      const call = pending.get(key);
      if (!call || call.tool !== tool) return null;
      pending.delete(key);
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
