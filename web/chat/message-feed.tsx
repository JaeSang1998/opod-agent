"use client";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import type { UIMessage } from "ai";

export function MessageFeed({
  characterId,
  messages,
}: {
  characterId: string;
  messages: UIMessage[];
}) {
  return (
    <Conversation className="flex-1">
      <ConversationContent>
        {messages.length === 0 ? (
          <ConversationEmptyState
            description={
              characterId
                ? `Talking to "${characterId}" with memory retrieval enabled.`
                : "No character set — plain OpenAI-compatible proxy."
            }
            title="No messages yet"
          />
        ) : null}

        {messages.map((message) => (
          <Message from={message.role} key={message.id}>
            <MessageContent>
              {message.parts.map((part, index) => {
                if (part.type === "reasoning") {
                  return (
                    <Reasoning
                      className="w-full"
                      isStreaming={part.state === "streaming"}
                      // biome-ignore lint/suspicious/noArrayIndexKey: AI SDK parts are ordered and expose no stable part ID.
                      key={`${message.id}-r-${index}`}
                    >
                      <ReasoningTrigger />
                      <ReasoningContent>{part.text}</ReasoningContent>
                    </Reasoning>
                  );
                }
                if (part.type === "text") {
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: AI SDK parts are ordered and expose no stable part ID.
                    <MessageResponse key={`${message.id}-t-${index}`}>{part.text}</MessageResponse>
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
