"use client";

import { Button } from "@/components/ui/button";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
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
import { useConsolidation } from "./use-consolidation";

const DEFAULT_SETTINGS: ChatSettings = {
  characterId: "luna",
  userId: "user-1",
  sessionId: "",
  maxTokens: "1024",
  temperature: "0.7",
};

export function ChatPlayground() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  useEffect(() => {
    setSettings((current) => ({ ...current, sessionId: crypto.randomUUID() }));
  }, []);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { error, messages, sendMessage, setMessages, status } = useChat({ transport });
  const {
    consolidate,
    reset: resetConsolidation,
    state: consolidation,
  } = useConsolidation(messages, settings);
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
          historyOffset: 0,
          maxTokens: Number(settings.maxTokens) || 1024,
          sessionId: settings.sessionId || undefined,
          temperature: Number(settings.temperature),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          turnId: crypto.randomUUID(),
          userId: settings.userId.trim() || undefined,
        },
      },
    );
  };

  const newSession = () => {
    updateSetting("sessionId", crypto.randomUUID());
    setMessages([]);
    resetConsolidation();
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
