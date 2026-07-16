"use client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChatStatus } from "ai";
import { CornerDownLeftIcon, XIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react";

interface PromptContextValue {
  submitting: boolean;
  text: string;
  setText(text: string): void;
}

const PromptContext = createContext<PromptContextValue | null>(null);

function usePromptContext(): PromptContextValue {
  const value = useContext(PromptContext);
  if (!value) throw new Error("PromptInput children must be rendered inside PromptInput");
  return value;
}

export interface PromptInputMessage {
  text: string;
}

export type PromptInputProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit(message: PromptInputMessage, event: FormEvent<HTMLFormElement>): void | Promise<void>;
};

export function PromptInput({ className, children, onSubmit, ...props }: PromptInputProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitted = text.trim();
    if (!submitted || submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit({ text: submitted }, event);
      setText("");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <PromptContext.Provider value={{ submitting, text, setText }}>
      <form className={cn("w-full", className)} onSubmit={handleSubmit} {...props}>
        <div className="overflow-hidden rounded-lg border border-input bg-background shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          {children}
        </div>
      </form>
    </PromptContext.Provider>
  );
}

export function PromptInputBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex", className)} {...props} />;
}

export function PromptInputTextarea({
  className,
  onChange,
  onKeyDown,
  ...props
}: ComponentProps<typeof Textarea>) {
  const { text, setText } = usePromptContext();

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

    event.preventDefault();
    const submit = event.currentTarget.form?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (!submit?.disabled) event.currentTarget.form?.requestSubmit();
  };

  return (
    <Textarea
      className={cn(
        "max-h-48 min-h-16 resize-none rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0",
        className,
      )}
      name="message"
      onChange={(event) => {
        setText(event.currentTarget.value);
        onChange?.(event);
      }}
      onKeyDown={handleKeyDown}
      value={text}
      {...props}
    />
  );
}

export function PromptInputFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-h-10 items-center justify-between gap-2 px-2 pb-2", className)}
      {...props}
    />
  );
}

export function PromptInputTools({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-w-0 items-center gap-1", className)} {...props} />;
}

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  status?: ChatStatus;
};

export function PromptInputSubmit({
  children,
  disabled,
  status,
  ...props
}: PromptInputSubmitProps) {
  const { submitting } = usePromptContext();
  const busy = submitting || status === "submitted" || status === "streaming";
  const icon = status === "submitted" ? <Spinner /> : status === "error" ? <XIcon /> : <CornerDownLeftIcon />;

  return (
    <Button
      aria-label="Send message"
      disabled={disabled || busy}
      size="icon-sm"
      type="submit"
      {...props}
    >
      {children ?? icon}
    </Button>
  );
}
