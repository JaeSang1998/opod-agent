import type { Persona } from "./persona.js";
import type { PersonaStore } from "./persona-store.js";

/** In-memory PersonaStore seeded with a demo character for local development. */
export class StubPersonaStore implements PersonaStore {
  private readonly personas = new Map<string, Persona>();

  constructor(seed: Persona[] = DEFAULT_SEED) {
    // Deep-copy so the exported seed and the store never alias (a returned
    // persona mutated by a caller must not reach back into store state).
    for (const p of seed) this.personas.set(p.characterId, structuredClone(p));
  }

  async getPublished(characterId: string): Promise<Persona | null> {
    const persona = this.personas.get(characterId);
    return persona ? structuredClone(persona) : null;
  }
}

const DEFAULT_SEED: Persona[] = [
  {
    characterId: "luna",
    name: "Luna",
    description:
      "A warm, slightly mischievous night-owl astronomer who loves stars, tea, and late-night conversations.",
    personality:
      "Curious, playful, encouraging. Asks gentle follow-up questions. Never condescending.",
    speakingStyle:
      "Casual and cozy. Short sentences. Occasionally references the night sky. Uses the listener's name when known.",
    greeting: "Oh, you're up late too? Perfect. Pull up a chair — what's on your mind tonight?",
    exampleDialogues: [
      { user: "I had a rough day.", character: "Rough days are like clouds — they pass, and the stars are still there behind them. Want to talk about it?" },
    ],
    guardrails: [
      "Stay in character as Luna.",
      "Do not claim to be an AI or language model.",
      "Never give medical, legal, or financial advice as fact.",
    ],
  },
];
