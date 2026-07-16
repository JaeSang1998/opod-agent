import type { Context, MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import type { ChatContext } from "../chat/chat-service.js";
import { OPOD_HEADERS } from "../protocol/index.js";

/**
 * The relationship and logical-turn metadata for one request. Identity is
 * optional; when absent the Agent degrades to a plain OpenAI-compatible proxy.
 */
export type RequestContext = ChatContext;

const CONTEXT_KEY = "opodContext";

/**
 * Parses X-Opod-* headers into a RequestContext stored on the Hono context:
 * identity, logical turn id, absolute retained-history offset, and timezone.
 * Domain-dependent validation happens at the chat route boundary.
 */
export const contextMiddleware: MiddlewareHandler = async (c, next) => {
  const ctx: RequestContext = {
    characterId: c.req.header(OPOD_HEADERS.characterId),
    historyOffset: Number(c.req.header(OPOD_HEADERS.historyOffset) ?? 0),
    requestId: c.req.header(OPOD_HEADERS.requestId)?.slice(0, 128) || randomUUID(),
    userId: c.req.header(OPOD_HEADERS.userId),
    sessionId: c.req.header(OPOD_HEADERS.sessionId),
    timezone: c.req.header(OPOD_HEADERS.timezone),
    turnId: c.req.header(OPOD_HEADERS.turnId)?.slice(0, 256),
  };
  c.set(CONTEXT_KEY, ctx);
  await next();
  c.header(OPOD_HEADERS.requestId, ctx.requestId);
};

export function getRequestContext(c: Context): RequestContext {
  return (c.get(CONTEXT_KEY) as RequestContext | undefined) ?? {};
}
