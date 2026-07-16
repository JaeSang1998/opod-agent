function separatorIndex(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function dataOf(event: string): string | null {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  return lines.length > 0 ? lines.join("\n") : null;
}

function eventNameOf(block: string): string | null {
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) return line.slice(6).trimStart();
  }
  return null;
}

/**
 * Parse SSE blocks — event name plus joined data — across arbitrary chunks,
 * CRLF frames, and a final unterminated event. opod-agent interleaves
 * "event: opod" debug frames between OpenAI data-only chunks (docs/adr/0006).
 */
export async function* readSSEEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      let separator = separatorIndex(buffer);
      while (separator) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const data = dataOf(block);
        if (data !== null) yield { event: eventNameOf(block), data };
        separator = separatorIndex(buffer);
      }

      if (done) {
        const data = dataOf(buffer);
        if (data !== null) yield { event: eventNameOf(buffer), data };
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Parse SSE data fields across arbitrary chunks, CRLF frames, and a final unterminated event. */
export async function* readSSEData(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  for await (const frame of readSSEEvents(stream, signal)) yield frame.data;
}
