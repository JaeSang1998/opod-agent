import { describe, expect, it } from "vitest";
import { classifyRequestError, createRequestSignal } from "./request-lifecycle.js";

async function waitForAbort(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return signal.reason;
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
  });
}

describe("request lifecycle", () => {
  it("aborts with a TimeoutError when the deadline wins", async () => {
    const signal = createRequestSignal(new AbortController().signal, 5);
    const reason = await waitForAbort(signal);
    expect(reason).toMatchObject({ name: "TimeoutError" });
    expect(classifyRequestError(reason)).toEqual({
      message: "upstream request timed out",
      status: 504,
      type: "timeout_error",
    });
  });

  it("preserves a client AbortError when the parent signal wins", async () => {
    const parent = new AbortController();
    const signal = createRequestSignal(parent.signal, 10_000);
    parent.abort(new DOMException("client disconnected", "AbortError"));
    const reason = await waitForAbort(signal);
    expect(reason).toMatchObject({ name: "AbortError" });
    expect(classifyRequestError(reason)).toEqual({
      message: "request cancelled",
      status: 408,
      type: "request_cancelled",
    });
  });

  it("maps unknown failures to a generic non-leaking server error", () => {
    expect(classifyRequestError(new Error("postgres://secret"))).toEqual({
      message: "internal server error",
      status: 500,
      type: "server_error",
    });
  });
});
