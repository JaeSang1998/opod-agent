import { z } from "zod";
import type { AgentTool, ToolContext } from "./tool.js";
import { reason } from "./tool.js";

const Args = z.object({
  timezone: z.string().optional(),
});

/** Current date & time in a given IANA timezone. Deterministic given a clock;
 *  no network. Falls back to ctx.timezone, then "UTC", when timezone is omitted. */
export function createGetTimeTool(clock: () => Date = () => new Date()): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "get_time",
        description:
          "Current date and time in a given IANA timezone. Use for \"what time is it there\" and cross-timezone questions.",
        parameters: {
          type: "object",
          properties: {
            timezone: {
              type: "string",
              description:
                "IANA timezone like \"Europe/Zurich\". When omitted, the user's own timezone (or UTC) is used.",
            },
          },
        },
      },
    },

    async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
      const { timezone } = Args.parse(rawArgs);
      const zone = timezone || ctx.timezone || "UTC";
      const now = clock();
      try {
        return format(now, zone);
      } catch (err) {
        return `get_time failed: invalid timezone "${zone}" (${reason(err)})`;
      }
    },
  };
}

/** Renders e.g. "2026-07-16 (Wednesday) 10:42 in Europe/Zurich". Throws
 *  RangeError on an unknown timezone (surfaced to the caller as an error). */
function format(now: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // hour12:false can emit "24" at midnight in some engines; normalize to "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${date} (${get("weekday")}) ${hour}:${get("minute")} in ${zone}`;
}
