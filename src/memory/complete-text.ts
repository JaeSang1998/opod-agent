import type { LLMProvider, ProviderCallOptions } from "../provider/llm-provider.js";

/**
 * Ask the provider's default model a single system+user prompt and return the
 * successfully completed reply text. The sleep-time passes —
 * extraction, reflection, summary — are all this exact shape, so they share this
 * instead of repeating the request/extract dance.
 */
export async function completeText(
  provider: LLMProvider,
  system: string,
  user: string,
  options: ProviderCallOptions,
): Promise<string> {
  const res = await provider.chat(
    {
      model: provider.defaultModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    options,
  );
  const choice = res.choices?.[0];
  const message = choice?.message;
  if (
    choice?.finish_reason !== "stop" ||
    typeof message?.content !== "string" ||
    message.refusal ||
    message.tool_calls?.length ||
    message.function_call
  ) {
    throw new Error("Invalid memory completion response");
  }
  return message.content;
}
