/** One selectable character, as listed by service-backend's `GET /characters`.
 *  Lives outside `backend/` so the client controls can import the type without
 *  pulling in the server-only fetch module. */
export interface CharacterOption {
  id: string;
  publicId: string;
  displayName: string;
}
