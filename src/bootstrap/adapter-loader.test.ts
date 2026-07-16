import { describe, expect, it, vi } from "vitest";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { StubMemoryStore } from "../memory/stub-memory-store.js";
import { StubPersonaStore } from "../persona/stub-persona-store.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { loadAdapterOverrides } from "./adapter-loader.js";
import { buildContainer } from "./container.js";
import { loadEnv, type Env } from "./env.js";

describe("loadAdapterOverrides", () => {
  it("loads a deployment module and passes database configuration to its factory", async () => {
    const provider = new FakeProvider();
    const personas = new StubPersonaStore();
    const memory = new StubMemoryStore();
    const queue = new StubJobQueue();
    let receivedEnv: Env | undefined;
    const createAdapters = vi.fn((factoryEnv: Env) => {
      receivedEnv = factoryEnv;
      return { provider, personas, memory, queue };
    });
    const importer = vi.fn(async () => ({ createAdapters }));
    const env = loadEnv({
      STORE_DRIVER: "postgres",
      DATABASE_URL: "postgres://db/opod",
      OPOD_ADAPTER_MODULE: "@opod/postgres-adapters",
      OPOD_WORKER_TOKEN: "a-very-long-worker-token",
    });

    const overrides = await loadAdapterOverrides(env, importer);
    const container = buildContainer(env, overrides);

    expect(importer).toHaveBeenCalledWith("@opod/postgres-adapters");
    expect(createAdapters).toHaveBeenCalledWith(env);
    expect(receivedEnv?.DATABASE_URL).toBe("postgres://db/opod");
    expect(container).toMatchObject({ provider, personas, memory, queue });
  });

  it("returns no overrides when no deployment module is configured", async () => {
    const importer = vi.fn();
    await expect(loadAdapterOverrides(loadEnv(), importer)).resolves.toEqual({});
    expect(importer).not.toHaveBeenCalled();
  });

  it("fails early when the module has no adapter factory", async () => {
    const env = loadEnv({ OPOD_ADAPTER_MODULE: "broken-adapters" });
    await expect(loadAdapterOverrides(env, async () => ({}))).rejects.toThrow(
      "must export createAdapters(env)",
    );
  });
});
