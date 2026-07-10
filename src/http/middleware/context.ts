import type { Context, MiddlewareHandler } from "hono";

/**
 * The character/user/session a turn belongs to. All fields are optional: when
 * absent the Agent degrades to a plain OpenAI-compatible proxy (docs/adr/0003).
 */
export interface RequestContext {
  characterId?: string;
  userId?: string;
  sessionId?: string;
}

const CONTEXT_KEY = "opodContext";

/** Parses X-Opod-* headers into a RequestContext stored on the Hono context. */
export const contextMiddleware: MiddlewareHandler = async (c, next) => {
  const ctx: RequestContext = {
    characterId: c.req.header("x-opod-character-id"),
    userId: c.req.header("x-opod-user-id"),
    sessionId: c.req.header("x-opod-session-id"),
  };
  c.set(CONTEXT_KEY, ctx);
  await next();
};

export function getRequestContext(c: Context): RequestContext {
  return (c.get(CONTEXT_KEY) as RequestContext | undefined) ?? {};
}

/** True when we have enough context to load a persona and personalize the turn. */
export function isPersonalized(ctx: RequestContext): boolean {
  return Boolean(ctx.characterId);
}
