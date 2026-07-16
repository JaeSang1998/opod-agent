import { describe, expect, it } from "vitest";
import { StubPersonaStore } from "./stub-persona-store.js";

describe("StubPersonaStore", () => {
  it("returns a copy so callers cannot mutate stored persona state", async () => {
    const store = new StubPersonaStore();
    const first = await store.getPublished("luna");
    expect(first).not.toBeNull();

    first!.name = "Mutated";
    first!.guardrails.push("Mutated rule");

    const second = await store.getPublished("luna");
    expect(second?.name).toBe("Luna");
    expect(second?.guardrails).not.toContain("Mutated rule");
  });
});
