import type OpenAI from "openai";


/** Allowlist the assistant wire message; provider-specific reasoning stays server-side. */
export function publicCompletion(completion: OpenAI.Chat.Completions.ChatCompletion): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: completion.id,
    object: completion.object,
    created: completion.created,
    model: completion.model,
    ...(completion.usage ? { usage: completion.usage } : {}),
    choices: completion.choices.map(choice => ({
      index: choice.index,
      finish_reason: choice.finish_reason,
      logprobs: null,
      message: {
        role: "assistant",
        content: choice.message.content,
        refusal: choice.message.refusal ?? null,
      },
    })),
  };
}
