"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useId } from "react";
import type { CharacterOption } from "./character-option";

const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ChatSettings {
  characterId: string;
  userId: string;
  sessionId: string;
  maxTokens: string;
  temperature: string;
  /** Passed through to the provider as `reasoning_effort`; "none" turns the
   *  model's thinking phase off entirely. */
  reasoningEffort: ReasoningEffort;
}

interface ChatControlsProps {
  /** Characters known to service-backend. Empty when it is unreachable or
   *  unconfigured — the field then falls back to free-text id entry. */
  characters: CharacterOption[];
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

function SelectField({
  className,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  label: string;
  onChange(value: string): void;
  options: { label: string; value: string }[];
  value: string;
}) {
  const id = useId();

  return (
    <label className="flex flex-col gap-1" htmlFor={id}>
      <span className="text-muted-foreground text-[11px] uppercase tracking-wide">{label}</span>
      <select
        className={cn(
          "rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          className ?? "h-8 w-40",
        )}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CharacterField({
  characters,
  onChange,
  value,
}: {
  characters: CharacterOption[];
  onChange(value: string): void;
  value: string;
}) {
  // No list (service-backend unreachable/unset) — fall back to typing the id.
  if (characters.length === 0) {
    return <Field className="h-8 w-28 text-sm" label="Character" onChange={onChange} value={value} />;
  }

  return (
    <SelectField
      className="h-8 w-44"
      label="Character"
      onChange={onChange}
      options={[
        // A hand-typed id (or the stub "luna") stays selectable instead of
        // silently snapping to the first character.
        ...(characters.some((c) => c.id === value) ? [] : [{ label: value, value }]),
        ...characters.map((c) => ({ label: `${c.displayName} (${c.publicId})`, value: c.id })),
      ]}
      value={value}
    />
  );
}

export function ChatControls({ characters, settings, onChange, onNewSession }: ChatControlsProps) {
  return (
    <header className="flex flex-wrap items-end gap-4 border-b px-4 py-3">
      <div className="mr-2">
        <h1 className="font-semibold text-sm">opod-agent</h1>
        <p className="text-muted-foreground text-xs">persona + memory · OpenAI-compatible Provider</p>
      </div>
      <CharacterField
        characters={characters}
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
      <SelectField
        className="h-8 w-28"
        label="Thinking"
        onChange={(value) => onChange("reasoningEffort", value as ReasoningEffort)}
        options={REASONING_EFFORTS.map((effort) => ({ label: effort, value: effort }))}
        value={settings.reasoningEffort}
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
