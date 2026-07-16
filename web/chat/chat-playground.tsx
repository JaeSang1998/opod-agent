"use client";

import { Button } from "@/components/ui/button";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { ConsolidationRequest } from "@opod/protocol/consolidation";
import { useEffect, useMemo, useState } from "react";
import { ChatControls, type ChatSettings } from "./chat-controls";
import { MessageFeed } from "./message-feed";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "./prompt-input";

const DEFAULT_SETTINGS: ChatSettings = {
  characterId: "luna",
  userId: "user-1",
  sessionId: "",
  maxTokens: "1024",
  temperature: "0.7",
};

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

export function ChatPlayground() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [consolidation, setConsolidation] = useState<ConsolidationState>({
    busy: false,
    text: "",
  });

  useEffect(() => {
    setSettings((current) => ({ ...current, sessionId: crypto.randomUUID() }));
  }, []);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { error, messages, sendMessage, setMessages, status } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  const updateSetting = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = (message: PromptInputMessage) => {
    if (busy) return;
    return sendMessage(
      { text: message.text },
      {
        body: {
          characterId: settings.characterId.trim() || undefined,
          maxTokens: Number(settings.maxTokens) || 1024,
          sessionId: settings.sessionId || undefined,
          temperature: Number(settings.temperature),
          userId: settings.userId.trim() || undefined,
        },
      },
    );
  };

  const consolidate = async () => {
    const turns = textTurnsOf(messages);
    const { characterId, sessionId, userId } = settings;
    if (!characterId || !userId || !sessionId || turns.length === 0) {
      setConsolidation({
        busy: false,
        error: true,
        text: "need character + user + session and at least one turn",
      });
      return;
    }

    setConsolidation({ busy: true, text: "consolidating…" });
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
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
      setConsolidation({ busy: false, text: JSON.stringify(data) });
    } catch (cause) {
      setConsolidation({
        busy: false,
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const newSession = () => {
    updateSetting("sessionId", crypto.randomUUID());
    setMessages([]);
    setConsolidation({ busy: false, text: "" });
  };

  return (
    <div className="mx-auto flex h-dvh w-full max-w-4xl flex-col">
      <ChatControls
        onChange={updateSetting}
        onNewSession={newSession}
        settings={settings}
      />
      <MessageFeed characterId={settings.characterId} messages={messages} />

      {error ? <p className="border-t px-4 py-2 text-destructive text-xs">{error.message}</p> : null}

      <div className="border-t p-4">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Message the character…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <Button
                disabled={consolidation.busy || busy}
                onClick={() => void consolidate()}
                size="sm"
                type="button"
                variant="outline"
              >
                {consolidation.busy ? "Consolidating…" : "Consolidate memory"}
              </Button>
              {consolidation.text ? (
                <span
                  className={`truncate text-xs ${
                    consolidation.error ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {consolidation.text}
                </span>
              ) : null}
            </PromptInputTools>
            <PromptInputSubmit status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
