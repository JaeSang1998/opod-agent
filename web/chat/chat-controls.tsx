"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useId } from "react";

export interface ChatSettings {
  characterId: string;
  userId: string;
  sessionId: string;
  maxTokens: string;
  temperature: string;
}

interface ChatControlsProps {
  settings: ChatSettings;
  onChange<K extends keyof ChatSettings>(key: K, value: ChatSettings[K]): void;
  onNewSession(): void;
}

function Field({
  className,
  label,
  onChange,
  type = "text",
  value,
}: {
  className?: string;
  label: string;
  onChange(value: string): void;
  type?: string;
  value: string;
}) {
  const id = useId();

  return (
    <label className="flex flex-col gap-1" htmlFor={id}>
      <span className="text-muted-foreground text-[11px] uppercase tracking-wide">{label}</span>
      <Input
        className={className ?? "h-8 w-40 text-sm"}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        value={value}
      />
    </label>
  );
}

export function ChatControls({ settings, onChange, onNewSession }: ChatControlsProps) {
  return (
    <header className="flex flex-wrap items-end gap-4 border-b px-4 py-3">
      <div className="mr-2">
        <h1 className="font-semibold text-sm">opod-agent</h1>
        <p className="text-muted-foreground text-xs">persona + memory · OpenAI-compatible Provider</p>
      </div>
      <Field
        className="h-8 w-28 text-sm"
        label="Character"
        onChange={(value) => onChange("characterId", value)}
        value={settings.characterId}
      />
      <Field
        className="h-8 w-28 text-sm"
        label="User"
        onChange={(value) => onChange("userId", value)}
        value={settings.userId}
      />
      <Field
        className="h-8 w-56 font-mono text-xs"
        label="Session"
        onChange={(value) => onChange("sessionId", value)}
        value={settings.sessionId}
      />
      <Field
        className="h-8 w-24 text-sm"
        label="Max tokens"
        onChange={(value) => onChange("maxTokens", value)}
        type="number"
        value={settings.maxTokens}
      />
      <Field
        className="h-8 w-20 text-sm"
        label="Temp"
        onChange={(value) => onChange("temperature", value)}
        type="number"
        value={settings.temperature}
      />
      <Button onClick={onNewSession} size="sm" type="button" variant="outline">
        New session
      </Button>
    </header>
  );
}
