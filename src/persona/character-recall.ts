import type { PersonaBlockSelector } from "./persona-router.js";
import type { ChatMessage } from "../protocol/index.js";

const normalize = (text: string) => text.trim().normalize("NFKC").toLowerCase();

/** A small Korean topic-cut heuristic, not general negation/intent detection. */
function activeSubject(query: string): string {
  return query.split(/말고|됐고|(?:얘기|이야기)(?:는|은)?\s*그만/u).at(-1) ?? "";
}

/** Bounded recent raw context only for referential follow-ups; not an intent model. */
export function contextRecallQuery(messages: readonly ChatMessage[]): string {
  const turns = messages.filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
  const last = turns.findLastIndex(m => m.role === "user");
  const current = String(turns[last]?.content ?? "");
  const subject = activeSubject(current);
  if (subject !== current) return subject;
  if (!/^(?:(?:그거|그건|그게|그걸|그때|거기|그\s*사람|그\s*곳)(?=$|[\s?!.,~은는을를이가도에])|(?:왜|어떻게|응|ㅇㅇ|맞아|그래)(?:요)?(?=$|[\s?!.,~ㅋㅎ]))/u.test(current.trim())) return current;
  return [...turns.slice(Math.max(0, last - 2), last).map(m => activeSubject(String(m.content)).slice(-512)), current].join("\n");
}

/** Prefer authored specific cues; no match means no recall, never a fill-up. */
export function selectCharacterRecallIds(
  query: string,
  sources: readonly { id?: string; content?: string; recallKeys?: readonly string[] }[],
  previousQuery?: string,
): string[] {
  const normalized = normalize(query);
  const subject = activeSubject(normalized);
  const match = (text: string) => sources.flatMap(source => {
    if (!source.id) return [];
    const score = Math.max(0, ...(source.recallKeys ?? []).map(key => {
      const cue = normalize(key);
      return cue && text.includes(cue) ? cue.length : 0;
    }));
    return score > 0 ? [{ id: source.id, content: source.content ?? "", score }] : [];
  });
  let candidates = match(subject);
  // One short referential follow-up may reuse the preceding user's subject.
  // A current cue or topic cut wins; assistant-generated topics never seed it.
  if (candidates.length === 0 && previousQuery && subject === normalized &&
    Array.from(normalized).length <= 120 && /^(?:그거|그건|그게|그걸|그때|거기|그\s*사람|그\s*곳)/u.test(normalized)) {
    candidates = match(activeSubject(normalize(Array.from(previousQuery).slice(-256).join(""))));
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  let remaining = 1200; // Content code points per owner (lore/canon), not tokens.
  for (const { id, content } of candidates.sort((a, b) => b.score - a.score)) {
    const fingerprint = normalize(content).replace(/\s+/gu, " ");
    const size = Array.from(content).length;
    if (size > remaining || (fingerprint && seen.has(fingerprint))) continue;
    ids.push(id);
    if (fingerprint) seen.add(fingerprint);
    remaining -= size;
    if (ids.length === 4) break;
  }
  return ids;
}

export class KeyphrasePersonaBlockSelector implements PersonaBlockSelector {
  async selectRelevantBlockIds(input: Parameters<PersonaBlockSelector["selectRelevantBlockIds"]>[0]): Promise<readonly string[]> {
    return selectCharacterRecallIds(input.query, input.blocks, input.previousQuery);
  }
}
