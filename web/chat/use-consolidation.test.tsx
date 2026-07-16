// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConsolidation } from "./use-consolidation";

const messages = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
] as UIMessage[];
const identity = { characterId: "luna", sessionId: "s1", userId: "u1" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useConsolidation", () => {
  it("reports missing identity without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useConsolidation(messages, { ...identity, sessionId: "" }),
    );

    await act(() => result.current.consolidate());

    expect(result.current.state).toMatchObject({ busy: false, error: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the shared contract and exposes a successful result", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConsolidation(messages, identity));

    await act(() => result.current.consolidate());

    expect(result.current.state).toEqual({ busy: false, text: JSON.stringify({ ok: true }) });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      characterId: "luna",
      reason: "manual",
      sessionId: "s1",
      turns: [{ role: "user", content: "hello" }],
      userId: "u1",
    });
  });

  it("aborts an active request when reset", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConsolidation(messages, identity));

    let request!: Promise<void>;
    act(() => {
      request = result.current.consolidate();
    });
    await waitFor(() => expect(result.current.state.busy).toBe(true));
    act(() => result.current.reset());
    await act(() => request);

    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(result.current.state).toEqual({ busy: false, text: "" });
  });
});
