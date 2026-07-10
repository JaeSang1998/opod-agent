import { Hono } from "hono";
import type { Container } from "../core/container.js";
import { contextMiddleware } from "./middleware/context.js";
import { health } from "./routes/health.js";
import { chatRoute } from "./routes/chat.js";
import { consolidateRoute } from "./routes/consolidate.js";

export function createApp(container: Container): Hono {
  const app = new Hono();

  app.use("*", contextMiddleware);

  app.route("/", health);
  app.route("/", chatRoute(container));
  app.route("/", consolidateRoute(container));

  return app;
}
