/** OpenAI-style error envelope shared by the HTTP routes. */
export function openaiError(type: string, message: string) {
  return { error: { type, message } };
}
