"use client";

import type { ConsolidationRequest } from "@opod/protocol";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

interface ConsolidationIdentity {
  characterId: string;
  sessionId: string;
  userId: string;
}

interface ConsolidationState {
  busy: boolean;
  text: string;
  error?: boolean;
}

function textTurnsOf(messages: UIMessage[]) {
  return messages.flatMap((message) => {
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    return content ? [{ role: message.role, content }] : [];
  });
}

const INITIAL_STATE: ConsolidationState = { busy: false, text: "" };

/** Owns the playground-only manual Consolidation request lifecycle. */
export function useConsolidation(messages: UIMessage[], identity: ConsolidationIdentity) {
  const [state, setState] = useState<ConsolidationState>(INITIAL_STATE);
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  const consolidate = useCallback(async () => {
    const turns = textTurnsOf(messages);
    const { characterId, sessionId, userId } = identity;
    if (!characterId || !userId || !sessionId || turns.length === 0) {
      setState({
        busy: false,
        error: true,
        text: "need character + user + session and at least one turn",
      });
      return;
    }

    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ busy: true, text: "consolidating…" });
    try {
      const body = {
        characterId,
        correlationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        reason: "manual",
        refreshSummary: true,
        sessionId,
        turns,
        userId,
      } satisfies ConsolidationRequest;
      const response = await fetch("/api/consolidate", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
      setState({ busy: false, text: JSON.stringify(data) });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setState({
        busy: false,
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [identity, messages]);

  const reset = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setState(INITIAL_STATE);
  }, []);

  return { consolidate, reset, state };
}
