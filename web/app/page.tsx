import { listCharacters } from "@/backend/characters";
import { ChatPlayground } from "@/chat/chat-playground";

// The character list must be read at request time. Without this the page is
// prerendered during `next build`, where service-backend is unreachable — the
// empty list would be baked into the image and never recover.
export const dynamic = "force-dynamic";

export default async function Page() {
  // Server-side, so the browser never needs to know service-backend's address.
  const characters = await listCharacters();
  return <ChatPlayground characters={characters} />;
}
