import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Container } from "../bootstrap/container.js";
import { chatRoute } from "../chat/http-route.js";
import { consolidateRoute } from "../memory/http-route.js";
import { contextMiddleware } from "./context.js";
import { health } from "./health.js";
import { openaiError } from "./errors.js";

export function createApp(container: Container): Hono {
  const app = new Hono();

  app.use("*", contextMiddleware);
  app.use(
    "*",
    bodyLimit({
      maxSize: container.env.MAX_REQUEST_BYTES,
      onError: (c) => c.json(openaiError("request_too_large", "request body too large"), 413),
    }),
  );

  app.route("/", health);
  app.route("/", chatRoute(container));
  app.route("/", consolidateRoute(container));

  return app;
}
