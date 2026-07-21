import { describe, expect, it } from "vitest";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { StubMemoryStore } from "../memory/stub-memory-store.js";
import { PostgresJobQueue } from "../memory/postgres-job-queue.js";
import { PostgresMemoryStore } from "../memory/postgres-memory-store.js";
import { StubPersonaStore } from "../persona/stub-persona-store.js";
import { PostgresPersonaStore } from "../persona/postgres-persona-store.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { buildContainer } from "./container.js";
import { loadEnv } from "./env.js";
import { noopLogger } from "./logger.js";

describe("buildContainer adapter seam", () => {
  it("accepts externally supplied Provider and persistence adapters", () => {
    const provider = new FakeProvider();
    const personas = new StubPersonaStore();
    const memory = new StubMemoryStore();
    const queue = new StubJobQueue();

    const container = buildContainer(loadEnv({
      OPOD_WORKER_TOKEN: "a-very-long-worker-token",
      STORE_DRIVER: "postgres",
    }), {
      provider,
      personas,
      memory,
      queue,
      log: noopLogger,
    });

    expect(container.provider).toBe(provider);
    expect(container.personas).toBe(personas);
    expect(container.memory).toBe(memory);
    expect(container.queue).toBe(queue);
  });

  it("names the missing adapters for an unknown non-stub store driver", () => {
    expect(() =>
      buildContainer(loadEnv({
        OPOD_WORKER_TOKEN: "a-very-long-worker-token",
        STORE_DRIVER: "dynamo",
      }), {
        provider: new FakeProvider(),
        log: noopLogger,
      }),
    ).toThrow("needs injected PersonaStore, MemoryStore, and JobQueue adapters");
  });

  it("wires built-in Postgres persistence for STORE_DRIVER=postgres", () => {
    const container = buildContainer(loadEnv({
      OPOD_WORKER_TOKEN: "a-very-long-worker-token",
      STORE_DRIVER: "postgres",
      DATABASE_URL: "postgresql://user:pw@localhost:5433/db",
    }), {
      provider: new FakeProvider(),
      log: noopLogger,
    });

    expect(container.personas).toBeInstanceOf(PostgresPersonaStore);
    expect(container.memory).toBeInstanceOf(PostgresMemoryStore);
    expect(container.queue).toBeInstanceOf(PostgresJobQueue);
  });

  it("refuses STORE_DRIVER=postgres without a DATABASE_URL", () => {
    expect(() =>
      buildContainer(loadEnv({
        OPOD_WORKER_TOKEN: "a-very-long-worker-token",
        STORE_DRIVER: "postgres",
      }), {
        provider: new FakeProvider(),
        log: noopLogger,
      }),
    ).toThrow('STORE_DRIVER="postgres" requires DATABASE_URL');
  });
});

describe("buildContainer tools", () => {
  const stubs = { provider: new FakeProvider(), log: noopLogger };

  it("builds no tools when TOOLS_ENABLED is false", () => {
    const container = buildContainer(loadEnv({ TOOLS_ENABLED: "false" }), stubs);
    expect(container.tools).toEqual([]);
  });

  it("includes get_time and get_weather but omits web_search without a key", () => {
    const container = buildContainer(loadEnv({}), stubs);
    const names = container.tools.map((t) => t.definition.function.name);
    expect(names).toContain("get_time");
    expect(names).toContain("get_weather");
    expect(names).not.toContain("web_search");
  });

  it("adds web_search when WEB_SEARCH_API_KEY is set", () => {
    const container = buildContainer(loadEnv({ WEB_SEARCH_API_KEY: "tvly-test" }), stubs);
    const names = container.tools.map((t) => t.definition.function.name);
    expect(names).toContain("web_search");
  });
});
