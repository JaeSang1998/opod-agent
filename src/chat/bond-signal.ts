import { type BondGrade, isBondGrade } from "../memory/bond.js";

/**
 * The back channel the character grades its own turn on.
 *
 * The character ends each reply with a marker — `[[bond:+1]]` — and the server
 * removes it before a single byte reaches the client. That buys a per-turn
 * judgement from the one model that actually read the exchange, for the price
 * of four tokens and no second call.
 *
 * The marker never reaches the user, so this module is the only thing standing
 * between a private signal and a leaked one. Three consequences shape it:
 *
 *   Streaming has to hold back. A chunk boundary can fall anywhere, including
 *   the middle of `[[bond:`, so anything that could still *become* a marker is
 *   buffered until it either completes or is ruled out.
 *
 *   Parsing is lenient, stripping strict. Models drift on whitespace and signs
 *   (`[[bond: +1 ]]`), so the pattern tolerates it — but everything the pattern
 *   matches is removed, including the whitespace in front of it, so a stripped
 *   marker leaves no trailing space where the message used to end.
 *
 *   The last marker wins. A user can talk a model into echoing anything; when
 *   that happens the echo lands mid-message and the character's own grade still
 *   comes last. The daily cap in bond.ts is the backstop that makes a
 *   successful trick worth almost nothing.
 */

/**
 * Tolerant on purpose — see above.
 *
 * The number is matched wide and clamped afterwards rather than restricted
 * here: a model that invents `[[bond:+7]]` should have it removed and read as
 * +2, never left in the message because it fell outside the scale. Leaking the
 * channel is the one failure that reaches the user.
 */
const BOND_SIGNAL_RE = /[ \t]*\r?\n?[ \t]*\[\[\s*bond\s*:\s*([+-]?\d{1,3})\s*\]\]/gi;

function toGrade(raw: number): BondGrade {
  const bounded = Math.max(-2, Math.min(2, Math.trunc(raw)));
  return isBondGrade(bounded) ? bounded : 0;
}

/** What the prompt asks for, and what tests round-trip against. */
export function formatBondSignal(grade: BondGrade): string {
  return `[[bond:${grade > 0 ? "+" : ""}${grade}]]`;
}

export interface BondSignal {
  /** The message as the user should see it: every marker removed. */
  text: string;
  /** The last grade found, or null when the character emitted none. */
  grade: BondGrade | null;
}

/** Strips every marker from a complete message and returns the last grade. */
export function extractBondSignal(raw: string): BondSignal {
  let grade: BondGrade | null = null;
  const text = raw.replace(BOND_SIGNAL_RE, (_match, digits: string) => {
    grade = toGrade(Number.parseInt(digits, 10));
    return "";
  });
  return { text, grade };
}

// ===== Streaming =====

/** How the marker opens. Anything shorter than this is still undecided. */
const MARKER_HEAD = "[[bond:";

/**
 * Longest run of text that may be withheld while a marker is still possible:
 * `[[bond:+1]]` plus room for the whitespace and the preceding newline the
 * pattern also eats. Past this length the candidate cannot complete, so the
 * text is released rather than held forever.
 */
const MAX_HOLD = 24;

export interface BondSignalRedactor {
  /** Feed one content delta; returns the text that is safe to forward now. */
  push(delta: string): string;
  /** Release everything still held — call once the stream is over. */
  flush(): string;
  /** The grade seen so far, or null. */
  grade(): BondGrade | null;
}

/**
 * Chunk-boundary-safe redactor. Text accumulates until it is provably not part
 * of a marker; a partial candidate at the tail is withheld and either completes
 * (and is dropped) or is released on the next delta once it can no longer
 * complete.
 */
export function createBondSignalRedactor(): BondSignalRedactor {
  let held = "";
  let grade: BondGrade | null = null;

  return {
    push(delta) {
      const { text, grade: found } = extractBondSignal(held + delta);
      if (found !== null) grade = found;

      const boundary = holdFrom(text);
      held = text.slice(boundary);
      return text.slice(0, boundary);
    },
    flush() {
      // Whatever is still held turned out to be ordinary text after all — a
      // message that genuinely ended in "[[" belongs to the user.
      const rest = held;
      held = "";
      return rest;
    },
    grade() {
      return grade;
    },
  };
}

/**
 * Index from which `text` must be withheld: the leftmost position inside the
 * trailing window that could still open a marker, extended back over the
 * whitespace the pattern would eat with it. `text.length` when nothing is at
 * risk.
 *
 * Trailing whitespace is held even with no candidate in sight, because the
 * space before a marker is only recognisable once the marker arrives — and a
 * space already sent cannot be taken back. It costs one delta of latency on a
 * character nobody is reading yet.
 */
function holdFrom(text: string): number {
  const windowStart = Math.max(0, text.length - MAX_HOLD);
  for (let i = windowStart; i < text.length; i += 1) {
    if (text[i] !== "[") continue;
    if (canStillComplete(text.slice(i))) return backOverWhitespace(text, i);
  }
  return backOverWhitespace(text, text.length);
}

function backOverWhitespace(text: string, from: number): number {
  let start = from;
  while (start > 0 && /[ \t\r\n]/.test(text[start - 1] as string)) start -= 1;
  return start;
}

/** Could this tail still grow into a marker? Whitespace-insensitive, like the pattern. */
function canStillComplete(tail: string): boolean {
  const compact = tail.replace(/\s+/g, "").toLowerCase();
  if (compact.length <= MARKER_HEAD.length) return MARKER_HEAD.startsWith(compact);
  return /^\[\[bond:[+-]?\d{0,3}\]?$/.test(compact);
}
