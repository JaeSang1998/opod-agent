import type { Context, MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import type { ChatContext } from "../chat/chat-service.js";
import { OPOD_HEADERS } from "../protocol/headers.js";

/**
 * The character/user/session a turn belongs to. All fields are optional: when
 * absent the Agent degrades to a plain OpenAI-compatible proxy (docs/adr/0003).
 */
export type RequestContext = ChatContext;

const CONTEXT_KEY = "opodContext";

/**
 * Parses X-Opod-* headers into a RequestContext stored on the Hono context:
 * x-opod-character-id, x-opod-user-id, x-opod-session-id, and x-opod-timezone
 * (raw IANA string; validation happens downstream).
 */
export const contextMiddleware: MiddlewareHandler = async (c, next) => {
  const ctx: RequestContext = {
    characterId: c.req.header(OPOD_HEADERS.characterId),
    requestId: c.req.header(OPOD_HEADERS.requestId)?.slice(0, 128) || randomUUID(),
    userId: c.req.header(OPOD_HEADERS.userId),
    sessionId: c.req.header(OPOD_HEADERS.sessionId),
    timezone: c.req.header(OPOD_HEADERS.timezone),
  };
  c.set(CONTEXT_KEY, ctx);
  await next();
  c.header(OPOD_HEADERS.requestId, ctx.requestId);
};

export function getRequestContext(c: Context): RequestContext {
  return (c.get(CONTEXT_KEY) as RequestContext | undefined) ?? {};
}
