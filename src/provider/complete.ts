import type { LLMProvider } from "./LLMProvider.js";

/**
 * Ask the provider's default model a single system+user prompt and return the
 * reply text (empty string if the model returns none). The sleep-time passes —
 * extraction, reflection, summary — are all this exact shape, so they share this
 * instead of repeating the request/extract dance.
 */
export async function completeText(
  provider: LLMProvider,
  system: string,
  user: string,
): Promise<string> {
  const res = await provider.chat({
    model: provider.defaultModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
}
