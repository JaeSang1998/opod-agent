import { serve } from "@hono/node-server";
import { loadEnv } from "./config/env.js";
import { buildContainer } from "./core/container.js";
import { createApp } from "./http/app.js";

const env = loadEnv();
const container = buildContainer(env);
const app = createApp(container);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  container.log(`opod-agent listening on :${info.port}`, {
    provider: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    store: env.STORE_DRIVER,
  });
});
