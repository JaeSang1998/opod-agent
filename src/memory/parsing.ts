import type { ArchivalMemory } from "./types.js";

/**
 * Tolerant parsers for the sleep-time passes' free-text LLM replies. The models
 * are asked for JSON or one-item-per-line, but neither is guaranteed, so every
 * parser here degrades gracefully rather than throwing on malformed output.
 */

export interface ParsedObservation {
  content: string;
  importance: number;
}

export interface ParsedInsight {
  content: string;
  /** ids of the evidence memories this insight cites. */
  evidence: string[];
}

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
export function parseObservations(text: string): ParsedObservation[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(arr)) {
        return arr
          .map(normalizeObservation)
          .filter((o): o is ParsedObservation => o !== null);
      }
    } catch {
      // fall through to the line-based fallback
    }
  }
  // Fallback: bullet/numbered lines with a default mid importance.
  return parseLines(trimmed).map((content) => ({ content, importance: 5 }));
}

/**
 * Parse "insight (because of 1, 3)" lines, mapping the 1-based statement numbers
 * to the evidence memories' ids.
 */
export function parseInsights(text: string, evidence: ArchivalMemory[]): ParsedInsight[] {
  return parseLines(text).map((line) => {
    const match = line.match(/\(([^)]*\d[^)]*)\)\s*$/);
    if (!match) return { content: line, evidence: [] };

    const content = line.slice(0, match.index).trim();
    const ids = (match[1]?.match(/\d+/g) ?? [])
      .map((n) => evidence[parseInt(n, 10) - 1]?.id)
      .filter((id): id is string => Boolean(id));
    return { content, evidence: ids };
  });
}

function normalizeObservation(x: unknown): ParsedObservation | null {
  if (typeof x === "string") {
    return x.trim() ? { content: x.trim(), importance: 5 } : null;
  }
  if (x && typeof x === "object" && "content" in x) {
    const content = String((x as { content: unknown }).content ?? "").trim();
    if (!content) return null;
    const rawImp = (x as { importance?: unknown }).importance;
    return { content, importance: clampImportance(Number(rawImp)) };
  }
  return null;
}

/** Coerce a model-supplied importance into the valid 1-10 integer range. */
function clampImportance(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}
