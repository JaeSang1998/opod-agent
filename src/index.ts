import { serve } from "@hono/node-server";
import { loadAdapterOverrides } from "./bootstrap/adapter-loader.js";
import { buildContainer } from "./bootstrap/container.js";
import { loadEnv } from "./bootstrap/env.js";
import { createApp } from "./http/app.js";

const env = loadEnv();
const overrides = await loadAdapterOverrides(env);
const container = buildContainer(env, overrides);
const app = createApp(container);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  container.log.info(`opod-agent listening on :${info.port}`, {
    provider: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    store: env.STORE_DRIVER,
  });
});
