"use client";

import { Button } from "@/components/ui/button";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useState } from "react";
import type { CharacterOption } from "./character-option";
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

// "luna" is the agent's built-in stub persona; it only resolves when the agent
// runs without a DATABASE_URL. With one set, personas come from Postgres only,
// so a real character id from service-backend is preferred when we have one.
const DEFAULT_SETTINGS: ChatSettings = {
  characterId: "luna",
  userId: "user-1",
  sessionId: "",
  // A reasoning model spends most of its budget thinking — at 1024 the answer
  // was routinely cut off mid-thought, which looks like a dropped connection.
  maxTokens: "8192",
  // Gemma 4's card gives one preset for every mode; the rest of it is pinned in
  // toOpodChatRequest.
  temperature: "1",
  // Thinking is off by default: a character reply doesn't need it, and it costs
  // the better part of a minute before the first word. For Gemma 4 this is a
  // true on/off — the levels only mean something to providers that implement
  // them (gpt-oss), so treat anything other than "none" as simply "on".
  reasoningEffort: "none",
};

export function ChatPlayground({ characters = [] }: { characters?: CharacterOption[] }) {
  const [settings, setSettings] = useState<ChatSettings>(() => ({
    ...DEFAULT_SETTINGS,
    characterId: characters[0]?.id ?? DEFAULT_SETTINGS.characterId,
  }));

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
          maxTokens: Number(settings.maxTokens) || 8192,
          reasoningEffort: settings.reasoningEffort,
          sessionId: settings.sessionId || undefined,
          temperature: Number(settings.temperature),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          turnId: crypto.randomUUID(),
          userId: settings.userId.trim() || undefined,
        },
      },
    );
  };

  // Show the authored name rather than the raw uuid once we know it.
  const characterLabel =
    characters.find((c) => c.id === settings.characterId)?.displayName ?? settings.characterId;

  const newSession = () => {
    updateSetting("sessionId", crypto.randomUUID());
    setMessages([]);
    resetConsolidation();
  };

  return (
    <div className="mx-auto flex h-dvh w-full max-w-4xl flex-col">
      <ChatControls
        characters={characters}
        onChange={updateSetting}
        onNewSession={newSession}
        settings={settings}
      />
      <MessageFeed characterLabel={characterLabel} messages={messages} />

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
