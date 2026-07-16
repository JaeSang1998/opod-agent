import "server-only";

const OPOD_URL = (process.env.OPOD_URL ?? "http://localhost:8787").replace(/\/$/, "");

/** The single outbound seam from the web playground to an opod-agent backend. */
export function fetchOpod(path: `/${string}`, init: RequestInit): Promise<Response> {
  return fetch(`${OPOD_URL}${path}`, init);
}
