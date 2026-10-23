"use client";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { useState } from "react";
import type { CharacterExperience } from "@opod/protocol";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { ToolPart } from "./tool-events";
import type { UIMessage } from "ai";


export type PlaygroundMessage = UIMessage<unknown, { opodCharacter: CharacterExperience; opodTool: ToolPart }>;

function PublicCharacterMoment({ experience }: { experience: CharacterExperience }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="space-y-2">
      {experience.thought ? (
        <aside aria-label="속마음" className="text-muted-foreground text-sm leading-relaxed">
          <span className="mr-2 font-medium">속마음</span>{experience.thought}
        </aside>
      ) : null}
      {experience.photo ? (
        <figure className="max-w-sm">
          {failed ? (
            <p role="status" className="rounded-xl bg-muted p-3 text-muted-foreground text-sm">
              사진을 불러오지 못했어요. {experience.photo.alt}
            </p>
          ) : (
            <a href={experience.photo.url} target="_blank" rel="noreferrer" aria-label={`사진 열기: ${experience.photo.alt}`} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
              {/* biome-ignore lint/performance/noImgElement: external sample catalog media is not managed by Next Image. */}
              <img src={experience.photo.url} alt={experience.photo.alt} width={384} height={288} onError={() => setFailed(true)} className="aspect-[4/3] w-full rounded-xl object-cover" />
            </a>
          )}
          {experience.photo.isMock ? <figcaption className="mt-1 text-muted-foreground text-xs">샘플 사진</figcaption> : null}
        </figure>
      ) : null}
    </div>
  );
}
export function MessageFeed({
  characterLabel,
  messages,
}: {
  characterLabel: string;
  messages: PlaygroundMessage[];
}) {
  let relationship: CharacterExperience["relationship"];
  for (let index = messages.length - 1; index >= 0 && !relationship; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "data-opodCharacter") relationship = part.data.relationship;
    }
  }
  return (
    <Conversation className="flex-1">
      {relationship ? (
        <section className="border-b px-4 py-2 text-muted-foreground text-xs" aria-label="친밀도">
          <details>
            <summary className="cursor-pointer">레벨 {relationship.level} · {relationship.label}</summary>
            <progress aria-label="친밀도 진행도" value={relationship.progress} max={1} className="mt-2 h-1.5 w-36 accent-foreground" />
            {relationship.change !== "steady" ? <p className="mt-1">{relationship.change === "closer" ? "조금 더 가까워졌어요." : "잠시 거리가 생겼어요."}</p> : null}
          </details>
        </section>
      ) : null}
      <ConversationContent>
        {messages.length === 0 ? (
          <ConversationEmptyState
            description={
              characterLabel
                ? `Talking to "${characterLabel}" with memory retrieval enabled.`
                : "No character set — plain OpenAI-compatible proxy."
            }
            title="No messages yet"
          />
        ) : null}

        {messages.map((message) => (
          <Message from={message.role} key={message.id}>
            <MessageContent>
              {message.parts.map((part, index) => {
                if (part.type === "data-opodCharacter" && message.role === "assistant") {
                  return <PublicCharacterMoment key={`${message.id}-character`} experience={part.data} />;
                }
                if (part.type === "text") {
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: AI SDK parts are ordered and expose no stable part ID.
                    <MessageResponse key={`${message.id}-t-${index}`}>{part.text}</MessageResponse>
                  );
                }
                if (part.type === "data-opodTool") {
                  const tool = part.data;
                  const running = tool.state === "running";
                  const label = running
                    ? `🔧 ${tool.tool} ${tool.args}`
                    : `🔧 ${tool.tool} · ${tool.ms}ms · ${(tool.result ?? "").slice(0, 120)}`;
                  return (
                    <span
                      className="inline-flex items-center gap-1 rounded border bg-muted/50 px-2 py-0.5 text-muted-foreground text-xs"
                      key={tool.id}
                      title={running ? undefined : tool.result}
                    >
                      {running ? <Shimmer as="span">{label}</Shimmer> : label}
                    </span>
                  );
                }
                return null;
              })}
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
