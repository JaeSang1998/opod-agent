import { describe, it, expect } from "vitest";
import { createGetTimeTool } from "./get-time.js";
import { noopLogger } from "../bootstrap/logger.js";
import type { ToolContext } from "./tool.js";

// 2026-07-16T08:42:00Z — a Thursday in UTC.
const FIXED = new Date("2026-07-16T08:42:00Z");
const clock = () => FIXED;
const tool = createGetTimeTool(clock);

const ctx = (timezone?: string): ToolContext => ({ log: noopLogger, timezone });

describe("createGetTimeTool", () => {
  it("declares get_time with no required fields", () => {
    expect(tool.definition.function.name).toBe("get_time");
    const params = tool.definition.function.parameters as Record<string, unknown>;
    expect(params.required).toBeUndefined();
  });

  it("formats the time in an explicit timezone", async () => {
    const out = await tool.execute({ timezone: "Europe/Zurich" }, ctx());
    // Zurich is UTC+2 in July → 10:42.
    expect(out).toBe("2026-07-16 (Thursday) 10:42 in Europe/Zurich");
  });

  it("falls back to ctx.timezone when the arg is omitted", async () => {
    const out = await tool.execute({}, ctx("Asia/Seoul"));
    // Seoul is UTC+9 → 17:42.
    expect(out).toBe("2026-07-16 (Thursday) 17:42 in Asia/Seoul");
  });

  it("falls back to UTC when neither arg nor ctx supplies a timezone", async () => {
    const out = await tool.execute({}, ctx());
    expect(out).toBe("2026-07-16 (Thursday) 08:42 in UTC");
  });

  it("returns an error string naming an invalid timezone", async () => {
    const out = await tool.execute({ timezone: "Mars/Olympus" }, ctx());
    expect(out).toContain("get_time failed");
    expect(out).toContain("Mars/Olympus");
  });
});
