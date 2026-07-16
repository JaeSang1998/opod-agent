import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Optional-in-dev, constant-time Bearer authentication for the worker route. */
export function isAuthorizedWorker(
  configuredToken: string | undefined,
  authorization: string | undefined,
): boolean {
  if (!configuredToken) return true;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  return timingSafeEqual(digest(configuredToken), digest(supplied));
}
