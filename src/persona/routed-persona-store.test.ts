import { describe, expect, it } from "vitest";
import { StubPersonaStore } from "./stub-persona-store.js";
import {
  RoutedPersonaStore,
  type PersonaRoutingManifest,
} from "./routed-persona-store.js";

const rawPersona = {
  characterId: "fixture-character",
  name: "Fixture",
  bio: "Synthetic test persona.",
  blocks: [
    { id: "block-a", title: "같은 제목", content: "First block." },
    { id: "block-b", title: "같은 제목", content: "Second block." },
  ],
  canonMemories: [],
};

const manifest: PersonaRoutingManifest = {
  schemaVersion: 1,
  mappingMode: "explicit_block_id",
  blocks: [
    { blockId: "block-a", kind: "voice", injection: "always" },
    { blockId: "block-b", kind: "lore", injection: "retrieved" },
  ],
};

describe("RoutedPersonaStore", () => {
  it("attaches typed routing by stable block id rather than title", async () => {
    const store = new RoutedPersonaStore(new StubPersonaStore([rawPersona]), manifest);

    expect((await store.get("fixture-character"))?.blocks).toEqual([
      {
        id: "block-a",
        title: "같은 제목",
        content: "First block.",
        kind: "voice",
        injection: "always",
      },
      {
        id: "block-b",
        title: "같은 제목",
        content: "Second block.",
        kind: "lore",
        injection: "retrieved",
      },
    ]);
  });

  it("rejects an incomplete explicit mapping instead of silently treating lore as always", async () => {
    const store = new RoutedPersonaStore(new StubPersonaStore([rawPersona]), {
      ...manifest,
      blocks: manifest.blocks.slice(0, 1),
    });

    await expect(store.get("fixture-character")).rejects.toThrow(
      "missing an explicit route for block block-b",
    );
  });

  it("rejects duplicate block ids in a routing manifest", () => {
    expect(
      () =>
        new RoutedPersonaStore(new StubPersonaStore([rawPersona]), {
          ...manifest,
          blocks: [manifest.blocks[0]!, manifest.blocks[0]!],
        }),
    ).toThrow("routing manifest block ids must be unique");
  });
});
