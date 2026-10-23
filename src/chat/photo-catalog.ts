export interface CharacterPhoto {
  id: string;
  url: string;
  alt: string;
  isMock: boolean;
}

export interface PhotoScene extends CharacterPhoto {
  characterId: string;
  context: string;
  minBondLevel: number;
}

/** Deliberate sample scene photography from Unsplash, not character portraits,
 * selfies, or evidence that a character visited these places. Replace these
 * mock assets with authored character-scoped media before a production catalog.
 */
const SAMPLE_SCENES = [
  { key: "coffee", image: "photo-1509042239860-f550ce710b93", alt: "샘플 사진 · 테이블 위의 따뜻한 커피 한 잔", context: "A quiet coffee break, a cafe conversation, or a small everyday pause.", minBondLevel: 1 },
  { key: "rain", image: "photo-1515694346937-94d85e41e6f0", alt: "샘플 사진 · 빗방울이 맺힌 창밖 풍경", context: "A rainy day, staying indoors, or listening to the rain together.", minBondLevel: 1 },
  { key: "books", image: "photo-1507842217343-583bb7270b66", alt: "샘플 사진 · 책으로 가득한 서가", context: "Reading, finding a book, studying, or talking about a favorite story.", minBondLevel: 2 },
  { key: "forest", image: "photo-1448375240586-882707db888b", alt: "샘플 사진 · 햇살이 스며드는 초록 숲", context: "A relaxing walk, fresh air, nature, or taking a break from a busy day.", minBondLevel: 2 },
  { key: "sunset", image: "photo-1472120435266-53107fd0c44a", alt: "샘플 사진 · 바다 너머로 지는 노을", context: "Sharing a peaceful sunset, missing someone, or reflecting on the end of a day.", minBondLevel: 3 },
  { key: "night", image: "photo-1519608487953-e999c86e7455", alt: "샘플 사진 · 별이 반짝이는 밤하늘", context: "A late-night heart-to-heart, dreams, or quietly watching the sky together.", minBondLevel: 4 },
  { key: "flowers", image: "photo-1490750967868-88aa4486c946", alt: "샘플 사진 · 부드러운 빛 아래 피어난 꽃", context: "A deeply affectionate exchange, celebrating a meaningful moment, or expressing gratitude.", minBondLevel: 5 },
] as const;

/** Shared mock scenes are explicitly scoped to the active character at binding. */
export function getMockPhotoCatalog(characterId: string): readonly PhotoScene[] {
  return SAMPLE_SCENES.map(scene => ({
    id: `mock:${encodeURIComponent(characterId)}:${scene.key}`,
    characterId,
    url: `https://images.unsplash.com/${scene.image}?auto=format&fit=crop&w=1200&q=85`,
    alt: scene.alt,
    isMock: true,
    context: scene.context,
    minBondLevel: scene.minBondLevel,
  }));
}
