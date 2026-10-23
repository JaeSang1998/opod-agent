import { z } from "zod";
import type { ChatMessage } from "../protocol/index.js";
import { getMockPhotoCatalog, type CharacterPhoto, type PhotoScene } from "../chat/photo-catalog.js";
import { preparePhotoSelectorInput, type PhotoSelector } from "../chat/photo-selector.js";
import type { AgentTool } from "./tool.js";

interface SharePhotoToolOptions {
  characterId: string;
  persona: string;
  bondLevel: number | null;
  messages: readonly ChatMessage[];
  selector: PhotoSelector;
  onPhoto: (photo: CharacterPhoto) => void;
  catalog?: readonly PhotoScene[];
}

const argsSchema = z.object({ intent: z.string().trim().min(1).max(400) }).strict();
const NO_PHOTO = "No photo was shared. Continue the conversation naturally without mentioning selection rules or services.";

/** Identity, catalog and relationship are bound once by the server, not tool args. */
export function createSharePhotoTool(options: SharePhotoToolOptions): AgentTool {
  const catalog = options.catalog ?? getMockPhotoCatalog(options.characterId);
  const eligible = catalog.filter(photo => photo.characterId === options.characterId &&
    typeof options.bondLevel === "number" && Number.isInteger(options.bondLevel) && options.bondLevel >= 1 && options.bondLevel <= 5 &&
    Number.isInteger(photo.minBondLevel) && photo.minBondLevel >= 1 && photo.minBondLevel <= options.bondLevel);
  let attempted = false;

  return {
    definition: {
      type: "function",
      function: {
        name: "share_photo",
        description: "Optionally share one clearly labeled sample scene photo when it fits this conversation. Describe the conversational intent only; a photo is not guaranteed. Never describe sample scenes as a selfie or proof of personal experiences.",
        parameters: {
          type: "object",
          properties: { intent: { type: "string", minLength: 1, maxLength: 400, description: "Why a scene photo would fit the current conversation." } },
          required: ["intent"],
          additionalProperties: false,
        },
      },
    },
    async execute(args, ctx) {
      const parsed = argsSchema.safeParse(args);
      if (attempted || !parsed.success || ctx.signal?.aborted) return NO_PHOTO;
      // Mark before awaiting to prevent concurrent calls or retries from fishing
      // for another decision, including after none or a network failure.
      attempted = true;
      if (!eligible.length) return NO_PHOTO;
      const input = preparePhotoSelectorInput(options.persona, options.messages, parsed.data.intent, eligible);
      if (!input) return NO_PHOTO;
      try {
        const id = await options.selector.select(input);
        if (ctx.signal?.aborted) return NO_PHOTO;
        const selected = eligible.find(photo => photo.id === id);
        if (!selected) return NO_PHOTO;
        const photo: CharacterPhoto = { id: selected.id, url: selected.url, alt: selected.alt, isMock: selected.isMock };
        options.onPhoto(photo);
        return JSON.stringify({ photo, instruction: "The sample scene photo is shared. Continue naturally; do not expose selection criteria or services, or claim this is a character selfie." });
      } catch {
        return NO_PHOTO;
      }
    },
  };
}
