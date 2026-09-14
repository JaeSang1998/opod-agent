import { z } from "zod";
import { createHash } from "node:crypto";
import type { ChatMessage } from "../protocol/index.js";
import type {
  ArchivalMemory,
  MemoryContextInjectionMode,
  MemorySourceMessage,
  MemoryType,
} from "./types.js";

/**
 * Validate sleep-time model output before it becomes persistent memory.
 * Invalid batches fail without including potentially private output in errors.
 */

export interface ParsedObservation {
  content: string;
  importance: number;
  memoryType?: MemoryType;
  contextInjectionMode?: MemoryContextInjectionMode;
  sourceMessages?: MemorySourceMessage[];
}

export interface ParsedReflection {
  content: string;
  /** ids of the evidence memories this Reflection cites. */
  evidence: string[];
}

const observationsSchema = z.array(z.object({
  content: z.string().trim().min(1),
  importance: z.number().int().min(1).max(10),
}));

const groundedObservationsSchema = z.array(observationsSchema.element.extend({
  memoryType: z.enum(["user_fact", "shared_episode", "interpretation"]),
  contextInjectionMode: z.enum(["always", "retrieved"]),
  sourceIndices: z.array(z.number().int().nonnegative().safe()).min(1)
    .refine((indices) => new Set(indices).size === indices.length),
}));

/** Split a model reply into clean lines, stripping bullets/numbering. */
export function parseLines(text: string): string[] {
  return text
    .split("\n")
    // Strip only recognized list markers: "-"/"*" or a number followed by "."/")".
    // A bare leading number is legitimate prose ("10 push-ups ...") and is kept.
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[).])\s+/, "").trim())
    .filter((l) => l.length > 0);
}

/** Parse the extraction reply into {content, importance} records. */
export function parseObservations(
  text: string,
  source?: { turns: ChatMessage[]; turnsStartOffset?: number },
): ParsedObservation[] {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    throw new Error("Invalid memory observation response");
  }
  if (source) {
    const offset = source.turnsStartOffset;
    if (offset === undefined || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + source.turns.length)) {
      throw new Error("Invalid memory observation source range");
    }
    const result = groundedObservationsSchema.safeParse(parsed);
    if (!result.success) throw new Error("Invalid memory observation response");
    return result.data.map(({ sourceIndices, ...observation }) => ({
      ...observation,
      sourceMessages: sourceIndices.map((index) => {
        const message = source.turns[index];
        if (!message || (message.role !== "user" && message.role !== "assistant") ||
          typeof message.content !== "string" || !message.content.trim() ||
          (observation.memoryType === "user_fact" && message.role !== "user") ||
          (observation.contextInjectionMode === "always" &&
            (observation.memoryType !== "user_fact" || message.role !== "user"))) {
          throw new Error("Invalid memory observation response");
        }
        return {
          role: message.role,
          content: message.content,
          position: offset + index,
          sha256: createHash("sha256").update(message.content).digest("hex"),
        };
      }),
    }));
  }
  const result = observationsSchema.safeParse(parsed);
  if (!result.success) throw new Error("Invalid memory observation response");
  return result.data;
}

/**
 * Parse "reflection (because of 1, 3)" lines, mapping the 1-based statement numbers
 * to the evidence memories' ids.
 */
export function parseReflections(text: string, evidence: ArchivalMemory[]): ParsedReflection[] {
  return parseLines(text).map((line) => {
    const match = line.match(/^(.+?)\s+\(because of (\d+(?:\s*,\s*\d+)*)\)$/);
    const content = match?.[1]?.trim();
    if (!content || !match?.[2]) throw new Error("Invalid memory reflection response");
    const ids = match[2].split(",").map((raw) => {
      const n = Number(raw);
      const source = Number.isSafeInteger(n) && n >= 1 ? evidence[n - 1] : undefined;
      if (!source?.id) throw new Error("Invalid memory reflection response");
      return source.id;
    });
    return { content, evidence: [...new Set(ids)] };
  });
}
