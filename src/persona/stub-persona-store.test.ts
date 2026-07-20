import { describe, expect, it } from "vitest";
import { StubPersonaStore } from "./stub-persona-store.js";

describe("StubPersonaStore", () => {
  it("returns a copy so callers cannot mutate stored persona state", async () => {
    const store = new StubPersonaStore();
    const first = await store.get("luna");
    expect(first).not.toBeNull();

    first!.name = "Mutated";
    first!.blocks.push({ title: "Mutated block", content: "x" });
    first!.canonMemories.push("Mutated fact");

    const second = await store.get("luna");
    expect(second?.name).toBe("Luna");
    expect(second?.blocks.map((b) => b.title)).not.toContain("Mutated block");
    expect(second?.canonMemories).not.toContain("Mutated fact");
  });

  it("returns null for an unknown character", async () => {
    const store = new StubPersonaStore();
    expect(await store.get("nobody")).toBeNull();
  });
});
