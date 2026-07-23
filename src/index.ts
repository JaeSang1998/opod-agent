import { serve } from "@hono/node-server";
import { loadAdapterOverrides } from "./bootstrap/adapter-loader.js";
import { buildContainer } from "./bootstrap/container.js";
import { loadEnv } from "./bootstrap/env.js";
import { createApp } from "./http/app.js";

const env = loadEnv();
const overrides = await loadAdapterOverrides(env);
const container = buildContainer(env, overrides);
const app = createApp(container);

container.consolidationWorker?.start();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  container.log.info(`opod-agent listening on :${info.port}`, {
    provider: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    store: env.STORE_DRIVER,
    personas: env.DATABASE_URL ? "postgres" : "stub",
    memoryWorker: container.consolidationWorker ? "in-process" : "off",
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // process.once suppresses the default signal exit, so this handler must
  // ALWAYS reach process.exit — worker or not (optional chaining alone would
  // short-circuit past it and leave the process ignoring SIGTERM).
  process.once(signal, () => {
    void Promise.resolve(container.consolidationWorker?.stop()).finally(() =>
      process.exit(0),
    );
  });
}
