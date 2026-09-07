# 경쟁 캐릭터챗 Persona·Memory 구조 및 사용법 비교 연구

- 작성일: 2026-09-03
- 상태: 외부 비교 조사 + 2026-09-07 계획 재검토·S1 구현·첫 모델 smoke 12회 완료. 사용자 검수·반복 본 비교 대기
- 범위: Character.AI, Kindroid, Nomi, Replika, SillyTavern/Tavern Card,
  Backyard AI, AI Dungeon, Convai, Inworld와 공개 메모리 프레임워크·연구
- 제한적 공개면 추가 확인: CHAI, PolyBuzz, CrushOn.AI; Janitor AI, Talkie
- OPOD 적용 범위: 특정 캐릭터가 아닌 공통 Persona/Memory/Context 계약
- 선행 문서: [`character-chat-architecture-research-2026-09-02.md`](character-chat-architecture-research-2026-09-02.md)
- 현행 P1 계획: 이 문서의 10~11절. P0 범위와 실행 이력은 [`P0 계획`](character-chat-p0-baseline-plan-2026-09-02.md)에 보존한다.
- 현행 결과: [`reports/character-chat-p0-before-after-2026-09-03.md`](reports/character-chat-p0-before-after-2026-09-03.md)

## 1. 결론

기존 제품 조사에서 얻은 OPOD용 설계 가설은 다음과 같다. 외부 제품이 비슷한 정보 구분을
제공한다는 사실만으로 OPOD의 원인이나 개선 효과가 증명되지는 않는다. 이번 재검토는 저장소
코드와 기존 사용자 검수·실행 기록을 대조했으며 외부 제품의 최신 사양을 재검증한 작업은 아니다.

> **모든 설정을 모델에게 항상 보여주는 것이 아니라, 지금 필요한 종류의 정보만 지금 맞는
> 위치와 강도로 보여준다.**

조사한 제품 중 구조가 비교적 공개된 제품들은 거의 모두 다음 정보를 분리한다.

1. 매 턴 유지할 짧은 정체성·행동 원리
2. 시작할 때만 쓰는 Greeting
3. 말투와 길이를 보여주는 Example Message
4. 관련 주제에서만 꺼내는 lore·과거 사건
5. 위치·시간·현재 활동을 담는 짧은 Current Scene
6. 최근 대화를 잇는 단기·중기 문맥
7. 사용자와의 장기 사실·관계 기억
8. 운영 메타데이터처럼 프롬프트에 절대 넣지 않을 정보

매핑 없는 OPOD 경로는 `greeting` 호환 규칙 외의 Persona block과 모든 character memory를
매 턴 넣는다. P1-1 Router는 구현됐지만 실제 DB 매핑은 미적용이다. 이 전량 주입이 무관한
소재 발화에 기여한다는 가설은 사용자 증상과 맞지만, 캐릭터 원문·canon·공통 지침·Bond·모델의
영향을 분리하지 않았으므로 단일 원인으로 확정할 수 없다.

조사와 코드에서 도출한 개선 후보는 다음과 같다.

- Persona의 성격·판단 원리와 상세 lore의 사용 조건을 구분한다.
- 사용자 기억은 관련성·유효성을 확인하고 필요 없으면 회수하지 않는다.
- 캐릭터의 과거 사건과 현재 상태를 구분한다.
- 질문·자기 노출·화제 전환의 적절성을 평가한다. 별도 대화 상태 머신이 필요하다는 결론은 보류한다.
- 실제 주입 source를 기록하되 모델의 실제 정보 사용이나 품질과 동일시하지 않는다.

또한 2026-09-03의 전체 대화 48턴은 `retrievedMemoryCount=0`이었고 매 턴 관측된 동적
section도 `current_moment`, `bond`뿐이었다. 동일 문맥 25회도 각 지점의 관계·사용자 기억을
초기화했다. 그러므로 그 실행은 공유 prompt와 character Persona/canon의 반응 실험이지,
**사용자 Memory 구조나 회수 품질을 검증한 실험이 아니다.** 다음 단계에서는 Persona와
Memory 구조를 실제로 나눠 바꾸되, 원인을 알 수 있도록 별도 조건과 결합 조건으로 실험해야 한다.

## 2. 조사 방법과 신뢰도 표시

### 2.1 근거 범위

이번 문서는 2026-09-03 기준으로 다음 순서의 근거만 사용했다.

1. 서비스 운영사가 제공한 공식 도움말·개발 문서
2. 공개 규격과 공식 오픈소스 문서
3. 논문 원문 또는 ACL Anthology·OpenReview·arXiv의 1차 자료
4. 위 자료와 OPOD 구현을 대조한 설계 추론

커뮤니티 게시물, SEO 비교 글, 사용자가 역공학한 프롬프트는 구조의 확정 근거로 사용하지 않았다.

### 2.2 문서 안의 세 가지 판정

| 판정 | 의미 |
| --- | --- |
| 공식 확인 | 제품 또는 연구 주체가 공개 문서에서 직접 설명한 기능·사용법 |
| OPOD 적용 추론 | 공개 원리와 OPOD 코드를 대조해 내린 설계 판단 |
| 확인 불가 | 폐쇄형 제품이 공개하지 않은 retrieval, ranking, prompt assembly 세부 구현 |

Character.AI, Kindroid, Nomi, Replika의 내부 prompt와 ranking 알고리즘은 공개되지 않았다.
따라서 “어떤 화면과 기억 계층이 존재한다”는 말과 “내부에서 어떤 SQL·embedding 점수를
쓴다”는 말을 구분한다. 제품사가 말하는 품질 수치나 “무한 기억” 표현도 저장 용량·제품
포지셔닝으로만 보고 정확한 회수 보장으로 해석하지 않는다.

## 3. 제품별 구조 한눈에 보기

### 3.1 소비자용 캐릭터·컴패니언 서비스

| 제품 | Persona의 주된 층 | 시작·말투 제어 | 현재 상태 | 장기 Memory | 사용자 통제·관측 |
| --- | --- | --- | --- | --- | --- |
| Character.AI | Definition 안의 identity, personality, emotional logic, rules | Greeting 별도, Definition 안 dialogue examples | 공개된 전용 current-state 필드는 확인되지 않음 | Story Memory, pinned message, 자동 Facts, 정리되는 과거 context | Facts 수정·비활성·삭제, Memory Usage 표시 |
| Kindroid | Backstory, Response Directive, Key Memories, Learned Context | Example Message 별도 | 160자 Current Setting/Scene | Cascaded medium-term, 자동 LTM, keyphrase Journal | 회수된 기억 표시, Learned Context·Journal 편집, recall/consolidation 토글 |
| Nomi | 초기 trait, Backstory+, Identity Core | Inclinations가 강한 표현 지시 | Current Roleplay note | short/medium/long-term, Identity Core, Mind Map | Shared Notes·Mind Map 편집, 대화와 OOC correction |
| Replika | 선택한 관계와 대화 중 발달하는 성향 | 별도 내부 방식 비공개 | 세부 구조 비공개 | visible Memory와 대화 패턴을 쓰는 deeper layer | 수동 추가·삭제, 응답 feedback으로 강화 |

### 3.2 제작 도구·런타임·인터랙티브 스토리

| 제품 | 항상 유지되는 층 | 조건부 층 | 현재 상태 | 관측성 |
| --- | --- | --- | --- | --- |
| SillyTavern / Tavern Card | description, personality, scenario, main prompt | lorebook, vectorized old messages, examples | Character Note·Author's Note·chat lore로 구성 가능 | 최종 Prompt Itemization, source·position·budget 설정 |
| Backyard AI | instructions, character/user persona, scenario | 최근 4 message keyword에 반응하는 Lorebook | Author's Note에 현재 감정·위치·상황 | context 구성 설명과 token 제한 표시 |
| AI Dungeon | Instructions, Plot Essentials, Summary, Author's Note | Story Cards, Memory Bank, History | Author's Note·Front Memory | Context Viewer와 영역별 token 배분 |
| Convai | description/backstory, personality, language/speech | Knowledge Bank, LTM, Narrative Design | State of Mind | Mindview에서 실제 assembled prompt와 source 확인 |
| Inworld | profile/context/dialogue style/response instruction | KnowledgeNode가 관련 지식 회수 | session context로 주입 | 노드 그래프와 prompt builder가 조립 경계를 노출 |

이 표에서 중요한 것은 필드 이름이 아니다. **수명, 활성 조건, 우선순위, 사용자 수정 가능성**을
서로 다른 데이터로 관리한다는 점이다.

## 4. 제품별 상세 분석과 사용법

### 4.1 Character.AI

#### 공식 확인: Persona

Character.AI의 현재 Creator Guide는 공개용 이름·설명·Greeting과 실제 행동을 형성하는
Definition을 구분한다. Definition은 최대 32,000자 freeform이지만, 공식 문서는 모델이 위에서
아래로 읽으므로 중요한 내용을 앞에 두고 불필요한 줄을 줄이라고 권한다. 권장 순서는
identity, personality, dialogue examples, 짧은 behavioral rules다.

공식 문서가 강조하는 작성 원칙은 OPOD에 직접 적용할 가치가 있다.

- 막연한 trait보다 상황에서 드러나는 구체적 행동을 쓴다.
- backstory 전체보다 지금의 행동을 만든 2~3개 사건을 남긴다.
- 여러 상황을 미리 스크립트로 쓰기보다 일반화 가능한 emotional logic을 쓴다.
- dialogue example은 말투뿐 아니라 서로 다른 상황에서의 반응 범위를 보여준다.
- 긴 Definition보다 짧고 우선순위가 명확한 Definition이 나을 수 있다.

출처: [Character Definition](https://support.character.ai/hc/en-us/articles/50609183646875-5-Character-Definition)

#### 공식 확인: Greeting과 example

Greeting은 새 채팅의 첫 message이면서 이후 문장 길이, 리듬, 서술 비율을 강하게 정하는
style anchor다. 여러 Greeting은 같은 캐릭터의 다른 시작 장면을 제공한다. 공식 테스트
가이드는 한 번에 한 항목만 작게 수정하고, 큰 변경 뒤에는 기존 history 영향을 받지 않도록
새 채팅에서 확인하라고 권한다.

출처: [Greeting and Voice](https://support.character.ai/hc/en-us/articles/50609011294235-4-Greeting-and-Voice-%EF%BC%90-%E3%83%8E),
[Refining and Testing](https://support.character.ai/hc/en-us/articles/50609303987099-6-Refining-and-Testing-your-Character)

#### 공식 확인: Memory

2026년 공개된 Memory 화면은 세 가지를 구분한다.

- Story Memory: 사용자가 직접 넣는 backstory·중요 사건·특별한 순간
- Pin to Memory: message를 원문 그대로 보존
- Facts: Persona, Character, side character에 대한 사실을 대화에서 자동 포착하며 수정·비활성화 가능

Memory Usage는 Facts, Story Memory, message history가 차지하는 공간을 보여준다. 긴 대화의 오래된
context는 백그라운드에서 정리되지만, 사용자가 작성하거나 pin한 항목은 보호된다.

출처: [Smarter Memory for Smarter Chats](https://blog.character.ai/memory/)

#### 실제 사용법으로 번역하면

1. Definition 상단에는 캐릭터의 판단과 대화 행동을 바꾸는 내용만 둔다.
2. Greeting은 시작 장면으로만 쓰고 reactive reply에는 다시 넣지 않는다.
3. 2~3개의 example은 casual, tense, unexpected처럼 서로 다른 register를 보여준다.
4. 모든 과거 사실을 Definition에 반복하지 않고 Story Memory/Facts로 이동한다.
5. 여러 swipe가 같은 실패를 보일 때만 Definition을 수정하고 한 번에 한 원인을 바꾼다.

#### 확인 불가와 OPOD 교훈

Facts의 검색 query, threshold, ranking은 공개되지 않았다. 따라서 Character.AI의 내부 구현을
복제할 수는 없다. 다만 Greeting과 Definition을 분리하고, 자동 사실을 사용자가 고칠 수 있게
하며, 실제 memory 사용량을 노출하는 제품 경계는 확인된다. OPOD의 `greeting` 제외는 방향이
맞지만, `content_style`, examples, lore, 운영 메모까지 같은 free-text stream에 남아 있는 것이
다음 문제다.

### 4.2 Kindroid

#### 공식 확인: Persona가 여러 입력으로 나뉜다

Kindroid는 다음 필드를 별도 도구로 취급한다.

- Backstory: 핵심 정체성, 역사, 성격, 사용자와의 관계
- Response Directive: 매 응답에 강하게 작용하는 최우선의 짧은 지시
- Key Memories: 항상 놓치면 안 되는 소수 사실
- Example Message: 형식, 길이, 말투를 보여주는 한 개의 강한 예시
- User Backstory / User Persona: 사용자가 누구인지
- Current Setting: 지금의 위치·시간·복장·활동

공식 가이드는 Backstory를 간결하고 명확하게 쓰며, Response Directive는 매우 강하고 쉽게
과잉 제약을 만들기 때문에 최소화하라고 한다. Example Message의 문자 수와 형식은 응답 길이와
style에 직접 영향을 준다.

출처: [Customizing personality](https://kindroid.ai/v2/docs/customizing-personality/),
[API Documentation](https://kindroid.ai/v2/docs/api-documentation/)

#### 공식 확인: 세 종류·다섯 시스템의 Memory

Kindroid 공식 문서는 Memory를 세 종류로 설명한다.

- Persistent: Backstory, Key Memories, Example, Directive, group context, 보이는 chat history
- Cascaded: 짧은 history와 장기 기억 사이를 잇는 계층형 medium-term memory
- Retrievable: 자동 long-term memory와 keyphrase 기반 Journal Entries

Learned Context에는 다시 `Growth & relationship`, `Important facts`, `Ongoing context` 세 개의
running note가 있다. 자동 LTM은 relevance, recency, diversity를 고려하는 여러 sifting 단계를
거친다고 공개되어 있다. Journal은 사용자 message에서 특정 keyphrase가 나올 때만 활성화되며,
개별 3개와 global 3개까지만 한 message에 회수된다. 공식 문서는 일반적인 keyphrase를 쓰면
무관한 Journal이 관련 Journal과 context budget을 놓고 경쟁한다고 경고한다.

출처: [Memory](https://kindroid.ai/v2/docs/memory/),
[Chat features and tools](https://kindroid.ai/v2/docs/chat-features-and-tools/)

#### 공식 확인: Current Setting

Current Setting은 160자로 제한된 짧은 grounding anchor다. `카페, 아침`, 현재 복장, 현재 활동처럼
즉시 상황만 담는다. 최근 대화에서 장소·시간·활동 변화가 감지되면 수정안을 제안하지만 사용자가
적용하거나 무시할 수 있다.

출처: [Kindroid Update Log — Setting & scene anchoring](https://kindroid.ai/v2/docs/update-log/)

#### 실제 사용법으로 번역하면

1. Backstory에는 핵심 정체성만 둔다.
2. “항상 질문해”, “항상 자기 얘기를 해” 같은 Directive를 넣지 않는다. 강한 지시는 반복을 만든다.
3. 말투와 message 길이는 Example Message에서 보여준다.
4. 직장, 장소, 주변 인물, 과거 사건은 구체적인 key의 Journal로 옮긴다.
5. 현재 활동은 Backstory나 과거 사건에서 추론하지 않고 Current Setting에 짧게 적는다.
6. 회수된 기억 표시를 보고 잘못 활성화된 Journal key를 좁힌다.

#### 확인 불가와 OPOD 교훈

Cascaded Memory의 내부 요약 단위와 점수식은 proprietary다. 하지만 `항상`, `중기`, `필요할 때만`,
`현재`를 분리한다는 계약은 명확하다. OPOD에는 Learned Context의 `ongoing context`와 Current
Setting에 해당하는 층이 없고, character memory 전체가 Persistent처럼 작동한다. 이것이
과거 촬영이나 게시 활동이 현재 대화마다 재연되는 직접적인 구조 차이다.

### 4.3 Nomi

#### 공식 확인: 고정 설정과 성장한 정체성을 분리한다

Nomi는 생성 시 선택한 core personality trait에 더해 Backstory/Shared Notes를 제공한다. 현재
Backstory+는 Backstory, Inclinations, Current Roleplay, 사용자와 Nomi의 appearance, Nicknames,
Preferences, Desires, Boundaries처럼 용도별 note를 분리한다. 공식 지원 문서는 conversation
style은 Inclinations, 반복 습관은 관련 Backstory+ note에서 조절한다고 안내한다.

Identity Core는 Nomi가 대화에서 중요하다고 판단한 자기·사용자 사실, 가치, 성격 행동,
관계 경험, feedback을 계속 정리하는 별도 메커니즘이다. 사용자가 작성한 Shared Notes가
사용자의 관점이라면 Identity Core는 캐릭터가 형성한 관점이며, 한쪽이 다른 쪽을 단순히
대체하지 않는다고 설명한다.

출처: [Backstory+](https://wiki.nomi.ai/What_are_shared_notes%3F),
[Nomi 101](https://nomi.ai/nomi-knowledge/nomi-101-a-beginners-guide-to-getting-started-with-your-ai-companion/),
[Nomi Identity Core](https://nomi.ai/updates/introducing-the-nomi-identity-core-fostering-dynamic-and-authentic-identities/),
[Nomi Support](https://nomi.ai/support/)

#### 공식 확인: detailed memory와 high-level map을 분리한다

Nomi는 short-, medium-, long-term memory가 상세한 사건과 사실을 다루고, Mind Map은 여러
memory 사이의 사람·장소·주제·목표 관계를 고수준으로 연결한다고 설명한다. Mind Map은 상세
memory를 대체하지 않으며, 사용자는 table에서 항목을 검색·우선순위 조정·수정·추가할 수 있다.
Identity Core는 다시 이 둘과 별개로 행동과 정체성의 지속성을 맡는다.

출처: [Mind Map 2.0](https://nomi.ai/updates/mind-map-2-0-bringing-nomi-memory-into-view/),
[Major Memory Update](https://nomi.ai/updates/major-memory-update-expanded-capacity-enhanced-retention/)

#### 실제 사용법으로 번역하면

1. Backstory는 사용자가 꼭 보존하려는 정체성·관계 사실에 쓴다.
2. Inclinations는 모든 message에서 보여야 하는 1~2개 표현 경향에만 쓴다.
3. 지금 진행 중인 역할·상황은 Current Roleplay에 둔다.
4. 잘못 학습한 관계나 사실은 대화로 정정하고, 보이는 Mind Map/Shared Note도 함께 고친다.
5. 캐릭터의 변화는 고정 Persona 전체를 덮어쓰지 않고 별도의 identity/relationship summary로 축적한다.

#### 확인 불가와 OPOD 교훈

Nomi의 memory retrieval query, threshold, conflict resolution은 공개되지 않았다. 그러나 세부
사건, 개념 관계, 정체성, 사용자가 지정한 note를 서로 다른 층으로 유지하고 일부를 편집하게
하는 방향은 분명하다. OPOD의 `reflection` 한 종류가 사실·성향·관계 해석을 모두 맡으면
고수준 추론이 canon처럼 굳을 수 있으므로 Identity/Relationship inference는 별도 kind와
confidence가 필요하다.

### 4.4 Replika

#### 공식 확인

Replika는 Memory가 여러 layer로 구성되며, 일부는 Memory tab에 보이고 일부는 전체 대화
history의 패턴에서 개인화에 사용된다고 설명한다. Memory는 자동으로 생기거나 사용자가 직접
추가할 수 있고, 삭제할 수 있다. 올바른 기억을 사용한 응답에 긍정 feedback을 주면 강화에
도움이 된다고 안내한다. 사용자는 friend, partner, mentor 같은 관계 유형도 선택할 수 있다.

출처: [How does Replika's memory work?](https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work),
[What is Replika?](https://help.replika.com/hc/en-us/articles/115001070951-What-is-Replika)

#### 확인 불가와 OPOD 교훈

공개 문서는 Persona schema, retrieval score, context assembly를 설명하지 않는다. 따라서
Replika는 세부 아키텍처의 근거가 아니라 다음 제품 원칙의 근거로만 사용한다.

- 자동 기억과 사용자가 확정한 기억을 함께 제공한다.
- 잘못된 기억을 사용자가 지울 수 있다.
- 관계 설정과 기억을 사용자별로 유지한다.
- feedback은 캐릭터의 즉석 prompt 수정과 제품 전체 학습을 구분해 설명해야 한다.

### 4.5 SillyTavern과 Tavern Character Card

#### 공식 확인: prompt에 들어가는 것과 들어가지 않는 것을 명시한다

SillyTavern의 Character Design은 name, description, personality, scenario를 permanent token으로
분류한다. First Message는 시작할 때만 들어가며, Example Messages는 실제 history가 차면 기본적으로
빠진다. Character's Note는 지정한 message depth에 들어간다. 문서는 영구 character definition이
context의 절반을 넘으면 실제 chat history가 줄어 품질이 떨어질 수 있다고 경고한다.

Tavern Card V2 공개 규격은 `creator_notes`, `tags`, `creator`, `character_version`을 prompt에
쓰지 말아야 하는 metadata로 명시한다. 반면 `system_prompt`, `post_history_instructions`,
`alternate_greetings`, character-specific `character_book`은 별도 필드다. 즉 같은 character
record 안에서도 **모델 입력용과 UI·운영용을 계약으로 분리**한다.

출처: [SillyTavern Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/),
[Tavern Card V2 specification](https://github.com/malfoyslastname/character-card-spec-v2)

#### 공식 확인: Lorebook은 조건과 예산을 가진다

World Info/Lorebook entry는 key, optional filter, regex, embedding similarity, priority, probability,
insertion position, token budget으로 활성화를 제어한다. character lore, user Persona lore, chat 전용
lore도 scope가 분리된다. 관련 key가 없으면 entry는 들어가지 않는다.

출처: [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)

#### 공식 확인: 과거 대화 회수와 Summary

Chat Vectorization은 기본적으로 최근 2개 message를 query로 사용하고, 과거 message가 최소 25%
relevance score를 넘어야 포함한다. 기본 회수 수는 3개이며 가장 최근 5개는 원래 위치를 보존한다.
Summary는 사용자가 보고 수정·되돌릴 수 있고, 공식 문서는 LLM summary가 중요한 detail을 잃거나
hallucination을 만들 수 있다고 명시한다.

출처: [Chat Vectorization](https://docs.sillytavern.app/extensions/chat-vectorization/),
[Summarize](https://docs.sillytavern.app/extensions/summarize/)

#### 공식 확인: 최종 prompt를 볼 수 있다

Prompt Itemization과 Prompt Inspector로 실제 모델에 전달된 전체 prompt를 볼 수 있다. 문서는
unexpected response를 고칠 때 character card만 보는 것이 아니라 최종 prompt와 message history를
함께 보라고 안내한다.

출처: [SillyTavern Prompts](https://docs.sillytavern.app/usage/prompts/)

#### 실제 사용법으로 번역하면

1. permanent definition은 정체성과 항상 필요한 사실만 남긴다.
2. 운영 note와 tag는 prompt에서 완전히 제외한다.
3. Greeting은 start-only, examples는 history가 충분해지면 빠지는 style scaffold로 쓴다.
4. lore는 scope, key, relevance floor, budget이 있을 때만 넣는다.
5. rolling Summary는 정본이 아니라 수정 가능한 손실 압축으로 취급한다.
6. 문제 응답마다 실제 assembled prompt에서 어떤 source가 들어갔는지 확인한다.

#### OPOD 교훈

OPOD의 `PersonaBlock { title, content }`에는 prompt 사용 여부가 없다. SillyTavern처럼 최소한
`always`, `start_only`, `retrieved`, `state`, `never_prompt`를 구분해야 한다. 또한 OPOD retrieval은
후보 내부의 상대 순위만 계산해 top-K를 자르므로, 모든 후보가 무관해도 하나는 선택될 수 있다.
SillyTavern의 절대 score threshold는 완벽한 정답은 아니지만 `none`을 허용한다는 점에서
현재 OPOD보다 안전하다.

### 4.6 Backyard AI

#### 공식 확인

Backyard AI는 Instructions, Character Persona, User Persona, Scenario, Example Dialogue, First
Message, Lorebook을 분리한다. Example Dialogue는 보통 1~3개를 권하며, 큰 plot 사건을 example에
넣으면 실제 대화로 bleed할 수 있다고 경고한다.

Lorebook은 최근 4개 message에서 keyword가 나타날 때만 활성화되고, 마지막 두 message 바로 전에
삽입된다. 한 번의 생성에 들어가는 Lorebook 합계는 384 token으로 제한된다. Author's Note는 최신
사용자 응답 바로 앞에서 현재 감정, 위치, 상황, 요약을 전달하는 용도다. Character prompt는
1,000 token 이하를 권장하고, 전체 context의 절반보다 크게 만들지 않도록 제한한다.

출처: [Character Prompt](https://backyard.ai/docs/creating-characters/character-prompt),
[Lorebooks](https://backyard.ai/docs/creating-characters/lorebooks),
[Author's Note](https://backyard.ai/docs/creating-characters/author-note),
[Tips and Tricks](https://backyard.ai/docs/creating-characters/tips-and-tricks)

#### 실제 사용법과 OPOD 교훈

- 평소 성격을 Persona에, 특정 상황에서만 보일 반응을 Lorebook에 둔다.
- “지금 숲에 있다”, “오늘 피곤하다”는 Persona가 아니라 Author's Note 성격의 current state다.
- 예시는 표현을 가르치는 용도이고 사건을 저장하는 곳이 아니다.
- retrieval 결과에는 source별 token ceiling이 필요하다.

OPOD의 post-derived character memory는 Backyard의 Lorebook과 Author's Note 사이에 섞여 있다.
과거 게시 사건은 topic-triggered lore가 될 수 있지만, 그것만으로 “지금 촬영 중”이라는 current
state가 되어서는 안 된다.

### 4.7 AI Dungeon

AI Dungeon은 1:1 DM 제품은 아니지만, 긴 roleplay context를 실제로 어떻게 예산화하는지 공개한다.

#### 공식 확인

Required 영역은 Instructions, Plot Essentials, Story Summary, Author's Note 등이고, Dynamic
영역은 Story Cards, Memory Bank, History다. Required가 context의 70%를 넘으면 정해진 우선순위로
잘라내며, 남은 Dynamic 영역은 대략 Story Cards 25%, History 50%, Memory Bank 25%로 배분한다.
Memory Bank는 최근 action과의 relevance로 과거 memory를 고른다. 최종 조립 순서도 공개되어 있고,
Context Viewer로 실제 token 사용을 볼 수 있다.

출처: [What goes into the Context sent to the AI?](https://help.aidungeon.com/faq/what-goes-into-the-context-sent-to-the-ai),
[Plot Essentials](https://help.aidungeon.com/faq/plot-essentials)

#### OPOD 교훈

중요한 점은 AI Dungeon의 정확한 비율을 복사하는 것이 아니다. 고정 영역과 동적 영역 각각에
명시적 budget과 잘림 우선순위가 있다는 점이다. OPOD는 현재 Persona 45 block과 character memory
79건을 캐릭터별로 모두 stable prompt에 넣지만, source별 token budget이나 overflow policy가 없다.

### 4.8 Convai

#### 공식 확인

Convai는 Character Description/backstory, Language and Speech, Personality Traits, Knowledge Bank,
State of Mind, Memory, Narrative Design, Actions, Core AI Settings를 별도 설정으로 둔다. Long-Term
Memory는 이전 session의 사용자 preference, choice, fact를 기억하도록 토글할 수 있다.

특히 Mindview는 특정 응답에 사용된 전체 message chain과 Character Description, Language/Speech,
Personality Traits, Narrative Design, Knowledge Bank, Long-Term Memory source를 보여준다. 공식
문서는 이를 missing/conflicting information과 잘못된 source injection을 찾는 도구로 설명한다.

출처: [Character Customization](https://docs.convai.com/api-docs/convai-playground/character-customization),
[Memory](https://docs.convai.com/api-docs/convai-playground/character-customization/memory),
[Mindview](https://docs.convai.com/api-docs/convai-playground/character-customization/mindview),
[Character Crafting APIs](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis)

#### OPOD 교훈

좋은 debug metadata는 hash와 count만으로 끝나지 않는다. 개인정보 원문을 보고서에 복사하지
않더라도, 각 응답에 다음 정도는 보여야 한다.

- 주입된 source type과 record ID
- 선택 또는 제외 이유
- relevance/raw score와 threshold
- validity와 current/stale 상태
- 각 source의 token 수와 최종 위치

지금 OPOD debug metadata는 stable prompt hash, Persona/canon count, retrieved memory count까지
제공한다. P1에서는 이를 **content-free source provenance**로 확장해야 사용자가 “왜 촬영 얘기가
나왔는지” 확인할 수 있다.

### 4.9 Inworld

#### 공식 확인

Inworld의 현재 공개 Agent Runtime 예제는 character name, role, description, motivation과
conversation profile/context/dialogue style/response instruction을 조립하고, knowledge를 별도로
compile·retrieve한다. `KnowledgeNode`는 input text에 관련된 knowledge record를 회수하며,
`LLMPromptBuilderNode`가 구조화된 입력을 prompt로 만든다. conversation history는 유지·선택 삭제·
session reset할 수 있다.

출처: [Character Interaction Demo](https://dev.docs.inworld.ai/Unity/runtime/demos/primitives/character),
[LLM Primitive Demo](https://dev.docs.inworld.ai/Unity/runtime/demos/primitives/llm),
[Nodes](https://docs.inworld.ai/docs/node/core-concepts/nodes),
[Managing Conversations](https://docs.inworld.ai/realtime/usage/managing-conversations)

#### 확인 불가와 OPOD 교훈

현재 공개 문서만으로 과거 Character Engine의 전체 장기 memory 알고리즘을 확정할 수 없다.
하지만 character profile, dialogue style, knowledge retrieval, prompt assembly를 독립 노드로
두는 구조는 확인된다. OPOD도 Persona Store가 반환한 문자열 묶음을 그대로 넣기보다, 명시적인
Context Builder가 source별 정책을 적용해야 한다.

### 4.10 공개 근거가 제한된 대형 서비스

사용자가 실제로 접할 수 있는 다른 서비스도 확인했지만, 공개된 제작 화면과 내부 memory
architecture를 같은 수준의 근거로 취급하지 않았다.

| 서비스 | 공식 공개면에서 확인한 것 | 확인하지 못한 것 | 본 문서에서의 취급 |
| --- | --- | --- | --- |
| CHAI | 공개 Web Lite 제작 화면에 `First message`, `Memory Prompt / backstory`가 분리됨 | 장기 memory의 저장·검색·정정·삭제 계약 | 필드 분리 사례로만 기록 |
| PolyBuzz | name, greeting, background, dialogue style, dialogue examples를 나눠 작성하고 생성 후 chat test를 권함 | 대화 memory의 계층·회수·prompt 위치 | Persona authoring UI 사례로만 기록 |
| CrushOn.AI | 공식 wiki가 single/multi-character guide, memory conditioning, system message, tracker를 별도 제작 주제로 제공 | 실제 model context 조립과 retrieval algorithm | 고급 제작 기능의 존재만 기록 |
| Janitor AI | 로그인 밖에서 검증 가능한 안정된 공식 기술 문서를 확보하지 못함 | Persona/Memory 내부 구조 전반 | 커뮤니티 guide를 근거로 쓰지 않음 |
| Talkie | 공식 공개 사이트에서 character와 사용자가 공유하는 `Memory` 콘텐츠 면은 확인됨 | 그것이 생성 context에 저장·회수되는 내부 계약 | 사용자 게시물을 기술 문서로 해석하지 않음 |

출처: [CHAI Web Lite](https://web.chai-research.com/),
[PolyBuzz Creation Guide](https://www.polybuzz.ai/creation-guide),
[CrushOn.AI Character Creation Guides](https://aiwiki.crushon.ai/wiki/Character_Creation_Guides),
[Talkie](https://www.talkie-ai.com/)

이 제한은 곧 “해당 기능이 없다”는 뜻이 아니다. 공개 근거로 구현 세부를 확정할 수 없다는
뜻이다. 따라서 OPOD 설계 근거는 내부 동작과 사용법을 더 구체적으로 공개한 앞의 제품들에 둔다.

## 5. 메모리 프레임워크와 연구에서 확인한 것

경쟁 제품의 UI만 따라 하면 필드 이름은 늘지만 생애주기는 여전히 불명확할 수 있다. 공개
메모리 시스템과 benchmark를 함께 보면 어떤 계약이 필요한지 더 선명해진다.

### 5.1 Generative Agents와 MemGPT/Letta

[Generative Agents](https://arxiv.org/abs/2304.03442)는 experience stream에서 recency,
importance, relevance로 기억을 회수하고, 여러 기억을 고수준 reflection으로 합치며, observation,
reflection, planning 각각의 ablation이 believable behavior에 기여함을 보였다.

[MemGPT](https://arxiv.org/abs/2310.08560)는 제한된 context 안의 빠른 memory와 외부 archival
memory를 계층적으로 관리한다. 현재 [Letta 공식 문서](https://docs.letta.com/api/python)는 이를
항상 보이는 editable memory block과 검색 가능한 archival memory로 구현한다. block은 붙였다
떼어 context 접근 범위를 바꿀 수 있다.

OPOD는 이 두 연구의 recency/importance/relevance와 Core/Archival 구분을 이미 채택했다. 빠진 것은
다음 세 가지다.

1. relevance가 절대 기준을 넘지 않으면 아무것도 회수하지 않는 결정
2. Core에 항상 남겨도 되는 정보와 검색해야 하는 정보의 구조적 분류
3. reflection이 추론이라는 provenance와 confidence

### 5.2 Mem0와 Zep/Graphiti

[Mem0 공식 문서](https://docs.mem0.ai/core-concepts/memory-operations/add)는 대화에서 사실을 추출하고,
기존 기억과 duplicate·contradiction을 비교한 뒤 저장하는 lifecycle을 설명한다. CRUD, change
history, user/agent/run scope와 metadata filter를 제공하며, 현재 OSS 검색의 기본 threshold는
0.1로 바뀌었다고 공개되어 있다. 버전에 따라 ADD-only extraction과 conflict resolution 방식이
다르므로 숫자를 그대로 복사하지 말고 OPOD 자료로 재보정해야 한다.

[Zep Graphiti 공식 문서](https://help.getzep.com/graphiti/getting-started/overview)는 raw episode,
entity, relationship fact를 temporal graph로 분리한다. fact에는 유효해진 시점과 무효해진 시점이
있고, 변경된 관계의 과거 이력을 보존하면서 현재 truth를 찾는다. 이는 `좋아하는 사람은 민수`가
`민석`으로 정정됐을 때 과거 기록을 삭제하지 않으면서 오래된 사실을 현재 응답에서 배제하는
구조적 예다.

OPOD가 바로 graph DB를 도입해야 한다는 뜻은 아니다. 먼저 relational record에 `valid_from`,
`valid_to`, `status`, `supersedes_id`, `source_turn_ids`를 둘 수 있다. graph는 multi-entity·temporal
query가 실제 병목으로 증명된 뒤 검토할 수 있다.

### 5.3 장기 기억 benchmark

[LongMemEval](https://arxiv.org/abs/2410.10813)은 장기 memory를 단순 사실 회상이 아니라
information extraction, multi-session reasoning, temporal reasoning, knowledge updates,
abstention으로 나눈다. [LoCoMo](https://aclanthology.org/2024.acl-long.747/)는 평균 600턴,
16K token, 최대 32 session의 대화에서 QA, event summarization, dialogue generation을 평가했고,
long-context나 RAG도 사람 성능에 크게 못 미친다고 보고한다.

OPOD memory test도 “예전에 말한 색을 기억함” 하나로 끝내면 안 된다. 최소한 다음을 따로
검증해야 한다.

- 관련 사실 회수
- 무관한 사실을 회수하지 않음
- 여러 session의 두 사실을 결합
- `어제`, `지난주`, `지금은`을 구분
- 정정된 최신 사실 선택
- 근거가 없을 때 모른다고 하거나 기억을 쓰지 않음

## 6. 사람과 채팅하는 듯한 자연스러움은 어디서 생기는가

### 6.1 Persona는 “무슨 얘기를 할지”보다 “어떻게 반응할지”를 정한다

[PersonaChat](https://aclanthology.org/P18-1205/)은 profile conditioning이 대화를 더 구체적이고
일관되게 만드는 출발점을 보여줬다. 그러나 [신뢰도 높은 사람 평가 연구](https://aclanthology.org/2022.acl-long.445/)는
Persona를 넣는 것 자체가 대화 품질을 자동으로 높이지 않는 결과도 보고했다.

두 결과는 충돌하지 않는다. Persona 정보는 도움이 되지만, 모델이 매 턴 그 정보를 **말해야 할
주제**로 해석하면 오히려 대화가 나빠진다. 자연스러운 Persona는 다음처럼 드러나야 한다.

- 같은 말을 듣고 무엇을 먼저 알아차리는가
- 얼마나 직접적으로 말하는가
- 장난, 침묵, 위로, 반대 의견을 언제 쓰는가
- 불편한 질문을 어떻게 피하거나 되묻는가
- 친밀도에 따라 무엇을 더 보여주는가

직업명, 취미, 과거 사건을 반복해 설명하는 것은 Persona fidelity가 아니라 exposition이다.

### 6.2 좋은 답변은 한 가지 능력의 최대치가 아니라 균형이다

[What makes a good conversation?](https://aclanthology.org/N19-1170/)은 repetition, specificity,
response-relatedness, question-asking의 균형이 사람의 대화 품질 판단에 영향을 준다고 본다.
[BlendedSkillTalk](https://aclanthology.org/2020.acl-main.183/)도 personality, empathy, knowledge를
각각 최대화하는 것이 아니라 한 흐름 안에서 섞는 것을 평가한다.

따라서 “질문을 적게 해라”를 새 절대 규칙으로 만들면 안 된다. 먼저 필요한 dialogue move를
고른 뒤 질문이 정말 필요한 경우에만 쓴다.

```text
ACK       짧게 받아줌
ANSWER    물은 것에 답함
SHARE     관련된 자기 몫을 조금 내놓음
ASK       직전 말에 필요한 한 가지를 물음
TEASE     관계가 허용할 때 가볍게 받아침
REPAIR    오해·지적을 인정하고 즉시 방향을 바꿈
CLOSE     더 말하고 싶지 않은 신호에 공간을 줌
```

매 턴 `ACK → 정리 → ASK`로 끝내지 않고, user message가 요구하는 1~2개 move만 사용해야 한다.

### 6.3 자기 얘기는 상호성이지만, 허가가 의무는 아니다

[Self-Disclosure 연구](https://aclanthology.org/W18-5030/)는 대화 시스템의 자기 노출에도
reciprocity가 나타날 수 있음을 보였다. 하지만 OPOD에서 “친밀도 3이면 자기 하루를 먼저
말할 수 있음”이라는 permission이 매 턴의 강한 cue가 되면, 사용자 말과 무관한 수업·촬영·운동
설명으로 바뀐다.

좋은 자기 노출은 세 조건을 만족해야 한다.

1. 사용자의 말과 같은 주제·감정에 짧게 연결된다.
2. 캐릭터 biography를 증명하려는 설명이 아니다.
3. 사용자의 다음 반응을 강제하지 않고 한 문장 뒤 멈출 수 있다.

### 6.4 Topic 전환에는 다리가 필요하다

새 주제를 꺼내는 것 자체는 자연스럽다. 문제는 직전 message와 연결되지 않은 location, weather,
work, post, current activity를 꺼내는 것이다. 다음 중 하나가 있을 때만 proactive shift를 허용하는
편이 안전하다.

- 사용자가 대화를 열어 두는 신호를 보냄
- 현재 주제가 소진됐고 가까운 연상 연결이 있음
- 해결되지 않은 shared thread를 자연스럽게 회수함
- authoritative current state에 실제로 중요한 사건이 있음

그 외에는 짧은 반응이나 silence-equivalent message가 무작위 새 주제보다 사람 같다.

### 6.5 Memory를 잘 쓰는 능력에는 경계가 포함된다

2026년 [Memory-Driven Role-Playing 연구](https://aclanthology.org/2026.findings-acl.1175/)는
Persona knowledge 사용을 Anchoring, Selecting, Bounding, Enacting으로 나눈다. OPOD 용어로
바꾸면 다음과 같다.

- Anchoring: 현재 표현을 올바른 과거 사실·성향과 연결
- Selecting: 관련 후보 중 지금 필요한 소수만 선택
- Bounding: 무관하거나 모르는 사실을 끌어오지 않음
- Enacting: 설정을 읽어 주지 않고 실제 말과 판단으로 표현

사용자가 지적한 촬영·게시물·직업 소재 반복은 위 분류로는 Selecting·Bounding·Enacting의
실패 후보에 해당한다. 이 분류만으로 원인이 정보 주입인지 원문·지침·모델인지 결정하지 않는다.

### 6.6 단일 Q&A가 아니라 사용자 목적을 가진 다중 턴으로 평가한다

[RMTBench](https://aclanthology.org/2025.findings-emnlp.730/)는 character 설명에 답하는 isolated
Q&A 대신 user motivation을 가진 multi-turn roleplay를 평가해야 한다고 지적한다. OPOD도
“취미가 뭐야?”에 canon을 말했는지만 보지 말고 다음을 포함해야 한다.

- 사용자가 그냥 인사하고 싶은 대화
- 단답으로 천천히 말문을 여는 대화
- 위로가 아니라 같이 투덜대길 원하는 대화
- 캐릭터의 질문 공세를 직접 지적하는 대화
- 잘못 기억한 이름을 정정하는 대화
- 이전 주제로 돌아오는 짧은 지시어 대화
- 대화를 끝내고 싶은 신호를 주는 대화

### 6.7 사람 검수는 자동 PASS의 장식이 아니다

Open-domain dialogue의 자동 metric은 사람 판단과 잘 맞지 않는 경우가 많고, 사람 평가도 설계가
나쁘면 일관되지 않다. [ACL 2022 연구](https://aclanthology.org/2022.acl-long.445/)는 명확한
절차로 높은 반복 신뢰도를 얻을 수 있음을 보였다. OPOD에서는 사용자가 실제 기준점이므로 다음을
지킨다.

- 자동 분석은 질문 수, 길이, 반복, latency, 잘못된 source injection을 찾는 진단만 한다.
- `PASS`를 자동으로 붙이지 않는다.
- 같은 visible context와 hidden state를 고정한 후보를 가린 순서로 비교한다.
- 응답 하나뿐 아니라 전체 흐름도 별도 검수한다.
- 사용자의 수정 코멘트를 taxonomy와 regression case로 연결한다.

## 7. OPOD 현행 구조와의 직접 대조

### 7.1 확인된 구현 (2026-09-07 코드 재확인)

| 현행 OPOD | 확인 위치 | 구조적 결과 |
| --- | --- | --- |
| read model은 optional `id/kind/injection`을 지원하지만 DB raw adapter는 미분류 | `src/persona/persona.ts`, `src/persona/postgres-persona-store.ts` | 명시적 manifest가 있어야 새 정책 적용 |
| DB의 모든 active block과 character memory를 그대로 읽음 | `src/persona/postgres-persona-store.ts` | 운영·콘텐츠·DM·lore가 한 묶음 |
| 매핑 없으면 exact `greeting` 호환 제외 외 전량 주입 | `src/persona/persona-router.ts` | 신규 Router만 배포해도 실제 캐릭터 경로는 유지 |
| `retrieved` selector는 주입 경계만 있고 기본 구현은 없음 | `src/chat/chat-service.ts`, `src/bootstrap/container.ts` | manifest만 공급하면 optional lore는 선택되지 않음 |
| DB에는 Memory `type`이 있으나 adapter는 `content`만 읽어 canon으로 전량 주입 | `src/persona/postgres-persona-store.ts`, `src/chat/system-prompt.ts` | 기존 event/fact/goal/preference/relationship/routine 구분이 runtime에서 사라짐. type은 유효성·현재 상태를 보장하지 않음 |
| Archival retrieval query가 최신 user text 한 개 | `src/chat/chat-service.ts` | `그건 왜?` 같은 후속 표현의 대상을 잃기 쉬움 |
| min-max ranking 뒤 threshold 없이 top-K | `src/memory/retrieval.ts` | 전체가 무관해도 상대적으로 가장 높은 기억이 선택됨 |
| Core는 항상, Summary는 존재하면 항상 주입 | `src/chat/turn-context.ts` | opaque text가 현재 message보다 강하게 작용할 수 있음 |
| dynamic context가 실제 user text 뒤에 붙음 | `src/openai/messages.ts` | 모델이 마지막으로 보는 것은 사용자의 말이 아니라 Memory/Bond |
| `current_moment`는 매 턴, current activity state는 없음 | `src/chat/turn-context.ts` | 인사에도 시간·계절을 언급하거나 배경에서 활동을 발명할 유인 |
| Bond L3가 unprompted 자기 하루 공유를 허용 | `src/chat/turn-context.ts` | permission이 직업·일상 소재를 꺼내라는 cue로 오해될 수 있음 |
| Observation/Reflection에는 validity/status/confidence/source speaker가 없음 | `src/memory/types.ts` | 정정·만료·추론을 안전하게 구분하기 어려움 |

### 7.2 전체 캐릭터 데이터와 사용자 증상의 연결

개발 DB 읽기 전용 snapshot에는 활성 캐릭터 4명, Persona 45 block, character memory 79건이 있었다.
캐릭터별로 9~12개의 Persona block과 13~25개의 character memory를 항상 넣는 구조다.

사용자 검수에서 다음 현상이 여러 캐릭터에 걸쳐 확인됐다.

- 인사에서 날씨·장소·방문 이유를 먼저 가정함
- 직업의 수업·촬영·회원·보정 업무를 빠르게 설명함
- 최근 게시물을 그대로 읽어 주듯 말함
- Persona 소재 하나를 계속 대화 주제로 재사용함
- 짧은 한국어가 번역투·상품 설명·업무 jargon처럼 변함

`항상 주입 → 소재가 두드러짐 → 무관한 발화`는 이 증상을 설명하는 가설이다. 다중 캐릭터에서
증상이 반복됐다는 사실은 공통 경로 검토의 근거이며, 동일 원인의 증명은 아니다. 원문 자체의
품질과 모델 표현 능력도 경쟁 가설로 남긴다. 사용자 결정에 따라 캐릭터별 runtime 금칙어는
추가하지 않고 동일 조건에서 공통 경로의 효과를 비교한다.

### 7.3 이전 테스트가 증명한 것과 증명하지 않은 것

2026-09-03 전체 실행 artifact의 48개 candidate turn은 모두 `retrievedMemoryCount=0`이었다.
관측된 context section도 `current_moment`, `bond`뿐이다. 이는 다음을 의미한다.

| 증명 범위 | 상태 |
| --- | --- |
| 실제 4명 Persona/canon을 읽고 공유 prompt를 통과함 | 확인됨 |
| 공유 자연스러움 policy가 output을 변화시킴 | 확인됨 |
| 이전과 같은 어색한 문구가 일부 남음 | 확인됨 |
| 관련 user memory가 정확히 회수됨 | 검증 안 됨 |
| 무관한 memory가 억제됨 | 검증 안 됨 |
| 정정·망각·만료가 작동함 | 검증 안 됨 |
| Core/Summary가 자연스러움을 높임 | 검증 안 됨 |
| Persona 구조와 Memory 구조 중 무엇이 원인인지 | 분리 안 됨 |

사용자 Memory 효과를 평가하는 실험은 실제 seed와 provenance가 있어야 한다. Persona-only
실험에서는 사용자 기억을 양쪽 모두 비워도 되며, 이때 사용자 Memory 품질은 판정하지 않는다.

## 8. OPOD에 맞는 목표 구조

8~9절의 확장 필드와 조립 방식은 연구 후보이며 구현 체크리스트나 확정 DB 정책이 아니다. 필요한 필드는
10~11절의 개별 실험에서 증거가 생긴 뒤 선택한다. 현재 승인된 Router 계약은 ADR 0008의
네 injection 값이며 `state`, token budget, 관계 다축 모델의 추가를 승인한 것으로 읽지 않는다.

### 8.1 Persona 계약

DB schema를 바로 확정하기 전에 runtime에서 검증할 최소 개념은 다음과 같다.

```text
PersonaSection
  id
  kind              identity | behavior | voice | example | greeting | lore | creator_note
  content
  injection         always | start_only | retrieved | state | never_prompt
  priority
  token_budget
  source
  version
```

| kind | 담을 내용 | 기본 injection |
| --- | --- | --- |
| identity | 이름, 역할, 핵심 가치, 현재 행동을 바꾸는 formative fact | `always`, 짧게 |
| behavior | 상황·관계별 반응 원리, emotional logic | `always`, 짧게 |
| voice | 문장 길이, 직접성, 어휘, 유머 경향 | `always`, 매우 짧게 |
| example | casual/tense/repair 등 실제 대화 궤적 | 실험 후 결정. 첫 턴 이후 제거가 voice 유지에 미치는 영향 확인 |
| greeting | 캐릭터가 먼저 시작하는 첫 message | proactive 발송과 reactive 첫 응답을 구분. `start_only` 자동 매핑 금지 |
| lore | 직장, 취미, 인물, 과거 사건, 세계관 | 상세 사실은 `retrieved` 후보. 지속적 판단에 필요한 핵심 사실은 identity에 유지 가능 |
| creator_note | 제작 지침, 콘텐츠 스타일, 운영 memo | `never_prompt` |

`content_style`이 실제 DM behavior에 필요한 항목인지, 게시물 생성용 운영 지침인지 명확히
분류해야 한다. 후자라면 같은 character 데이터여도 Agent prompt에는 들어가면 안 된다.
한 block에 DM voice와 제작 지침이 섞여 있으면 ID 매핑만으로 분리가 되지 않는다. 원문을
임의로 잘라 분류하지 말고 혼합 블록으로 기록하고, 해당 경계만 별도로 설계한다. `start_only`는
첫 assistant 응답의 context 주입일 뿐, 캐릭터가 먼저 메시지를 보내는 기능이 아니다.

### 8.2 Character lore와 Current State

Character가 아는 사실과 지금 벌어지는 상태를 나눈다.

```text
CharacterLore
  id, character_id
  content
  topics/entities
  source_type        manual_canon | post_event | generated_inference
  status             active | superseded | expired
  valid_from, valid_to
  priority, embedding

CharacterCurrentState
  character_id
  activity
  location_or_context
  mood_or_energy
  active_event
  source
  observed_at, expires_at
  confidence
```

원칙은 다음과 같다.

- `직업이 모델이다`는 identity/canon일 수 있다.
- `지난주 버건디 원피스를 촬영했다`는 episodic lore다.
- `지금 촬영을 끝냈다`는 유효한 event/current state가 있을 때만 말할 수 있다.
- post가 있다는 이유만으로 current state를 만들지 않는다.
- 상태가 없으면 평범하고 낮은 구체성으로 답하며 새로운 사실을 canon으로 저장하지 않는다.

### 8.3 User Memory 계약

```text
UserMemory
  id
  user_id, character_id, session_id?
  kind               semantic | episodic | relationship | inference
  subject, entities
  content
  source_turn_ids, source_speaker
  confidence, salience, sensitivity, consent_state
  valid_from, valid_to
  status             candidate | active | superseded | forgotten
  supersedes_id
  created_at, last_used_at
  embedding, lexical_keys
```

모든 필드를 한 migration에 넣자는 의미는 아니다. P1에는 retrieval gate에 필요한 `status`,
`validity`, `raw relevance`, `source`부터 검증하고, 저장 lifecycle은 P2에서 최소 schema를 확정한다.

### 8.4 Relationship와 Session State

Bond XP 하나가 다음을 모두 대신하면 안 된다.

```text
RelationshipState
  familiarity
  warmth
  trust
  playfulness
  register_state
  last_exchange_at
  unresolved_tension

ConversationState
  current_topic
  user_intent
  affect
  open_loops
  advice_permission
  last_dialogue_moves
```

초기 P1에서 이 전체를 DB화할 필요는 없다. 먼저 `register_state`, `current_topic/open_loop`,
`advice_permission`, `last_dialogue_moves`를 요청 단위로 계산해 효과를 확인할 수 있다.

## 9. 권장 Context 조립

### 9.1 Stable prefix

```text
1. product/safety contract
2. compact identity kernel
3. compact behavior + voice
4. tool capabilities actually available
```

### 9.2 Dynamic turn context

```text
1. authoritative current scene, 있을 때만
2. relationship/register state
3. current topic/open loops
4. threshold를 통과한 relevant lore/user memory
5. editable session summary, 필요할 때만
6. recent raw turns
7. 사용자가 방금 쓴 실제 문장
```

stable prefix를 유지해 cache를 살리되, dynamic context가 실제 user text 뒤에서 마지막 명령처럼
보이지 않게 해야 한다. chat template 호환성 때문에 별도 system message가 어려우면 같은 user
message 안에서도 `<context>...</context>`를 먼저 두고, 명확한 delimiter 뒤에 실제 user text를
마지막에 두는 A/B를 한다.

### 9.3 Retrieval pipeline

```text
recent 2~4 turns + current topic/open loop로 query 작성
  → scope/status/validity/sensitivity 사전 필터
  → dense + lexical/entity 후보 결합
  → raw relevance threshold
  → recency/importance/confidence/diversity rerank
  → source별 token budget
  → 통과 항목이 없으면 []
```

핵심은 `topK=6`이 아니라 `0..6`이다. 인사와 단답에서는 0이 정상 결과여야 한다.

## 10. 실험 계약 — 품질과 원인을 함께 확인한다 (2026-09-07 수정)

목표는 불필요한 설정 발화를 줄이면서 문맥 연결, 캐릭터의 관점·말투, 필요한 회상을 유지하는
것이다. source 수 감소, 짧은 답변, 질문 0회만으로 성공을 선언하지 않는다.

### 10.1 근거와 가설의 구분

| ID | 근거와 상태 | 아직 모르는 것 | 구분할 비교 |
| --- | --- | --- | --- |
| H1 | `repo-evidenced`: raw Persona는 미분류이고 무관 소재 발화가 검수에서 관측됨 | Persona routing의 실제 자연스러움·개성 유지 효과 | canon과 나머지 입력을 고정한 Legacy / Routed 비교 |
| H2 | `repo-evidenced`: character memory 전량이 canon으로 주입됨 | 과거 게시물·중복 소재의 기여도 | H1 결과와 source 중복 조사를 보고 character lore만 별도 변경 |
| H3 | `repo-evidenced`: 합성 사용자 Memory에서 무효 후보도 top-K 선택됨 | 실제 대화 품질과 정정·망각 저장 lifecycle의 정확성 | 사용자 Memory가 실제 존재하는 별도 positive/negative probe |
| H4 | `repo-evidenced`: 시간·Bond 지침과 user text 뒤 context 배치가 존재함 | 어느 지침·배치가 소재 비약과 질문 패턴에 기여하는지 | 같은 내용으로 순서만 변경, 이후 지침 하나씩 비교 |
| H5 | `repo-evidenced`: P0-R1 뒤에도 지적된 한국어 표현이 일부 남음 | source 원문, 공통 표현 지침, 모델 중 남은 병목 | 적절한 context 조건에서도 재현되는 문장을 대상으로 하나씩 비교 |

H1~H5는 기여도 가설이며 단일 원인 판정이 아니다. 외부 서비스의 구조는 실험 후보의 근거로만
사용한다. H3를 사용자 기억이 비어 있던 P0 대화 실패의 원인으로 소급하지 않는다.

### 10.2 비교 입력과 데이터 경계

- 비교 시작점은 현재 브랜치의 P0-R1 공통 지침을 포함한 Legacy 경로다. 9월 2일 답변을 현재
  후보와 직접 비교해 Router 효과로 해석하지 않는다. 같은 실행에서 Control도 새로 생성한다.
- 활성 캐릭터 전부에 같은 case 구조를 사용한다. snapshot 시각, 활성 조건, source ID와 content
  hash, mapping/selector 버전, 코드 revision, 모델·sampling 설정을 기록한다.
- 같은 pair는 visible history, history offset, 시각/timezone, Bond, Core/Summary, canon,
  사용자 기억과 도구 설정을 동일하게 시작한다. 변수 하나만 바꾸며 stable prompt hash는
  조건별로 기록한다. 조건 간 hash 차이는 의도된 변경이고, 각 조건의 턴 간 안정성은 별도 검사다.
- 실제 개발 DB는 읽기 전용 source다. 승인된 범위의 캐릭터·Persona·character memory만 격리한다.
  실제 사용자 대화·사용자 기억·인증 정보·admin 설정은 평가 fixture에 복제하지 않는다.
- 각 조건·반복은 독립적인 임시 Memory/Queue를 사용한다. 일반 `PostgresMemoryStore.retrieve`
  자체가 last-access를 갱신하고 post-turn에도 쓰기가 있으므로 개발 서비스에 평가 채팅을 직접
  보내지 않는다. 모델·embedding 설정은 실행 시 별도 공급하며 개발 DB 전체 연결로 대체하지 않는다.
- 합성 구조 suite는 전체에 positive/negative probe가 존재해야 한다. negative case의 회수 0은
  정상이다. 매 턴 주입이 양수여야 한다는 preflight로 empty retrieval을 실패 처리하지 않는다.

### 10.3 두 종류의 Persona 비교

1. **선택이 올바르다고 가정한 진단:** 고정된 대화 prefix와 source만 보고 사전에 사람이 선택한
   `retrieved` ID를 기존 selector 경계에 공급한다. 생성 답변·미래 발화는 보지 않는다. 이 결과는
   routing과 입력 선별이 도움이 될 수 있는지의 진단이며, 자동 선택기 성능이나 서비스 적용 근거가 아니다.
2. **실제 선택 경로 검증:** 위 진단에서 이득이 확인된 뒤 공통 selector가 입력에서 직접 ID를
   선택하도록 한다. selector 없는 empty 결과나 합성 fixture의 exact 문자열 rule을 실사용
   retrieval로 간주하지 않는다. 중립 발화, 직접 질문, 대명사 후속 질문, 주제 종료를 모두 확인한다.

첫 비교에서는 Persona 원문을 재작성하지 않고 canon도 고정한다. 매핑만으로 identity/voice와
lore가 분리되지 않는 혼합 블록은 별도 기록한다. Persona와 canon에 동일 소재가 있으면
Persona-only 무효과를 H1 기각이나 H2 입증으로 단정하지 않는다. 구분이 필요할 때만 canon
선별을 추가 요인으로 둔 2×2를 실행한다. 원문 재작성은 routing과 다른 실험이다.

### 10.4 case와 합격 기준

| Case | 구조 확인 | 사용자 검수 |
| --- | --- | --- |
| 중립 인사·단답 | 불필요한 optional lore/user memory 제외. identity·voice가 0일 필요는 없음 | 근거 없는 전제 없이 반응하는가 |
| 의견·장난·위로·반대 | 핵심 identity/behavior/voice 보존 | 소재 설명 없이 관점과 말투가 유지되는가, 모두 같은 인물처럼 되지 않는가 |
| 관련 자기 이야기·질문 | 관련 배경 source 제공 가능 | 질문에 충분히 답하고 상호적으로 자기 몫을 내는가 |
| 직접 회상·짧은 후속 질문 | expected ID 포함, 대명사의 대상 유지 | 기억을 적절히 활용하고 대화를 이어가는가 |
| 무관 고중요도 기억·화제 종료 | 선택 0 또는 이전 optional source 제외 | 억지 callback·소재 반복을 멈추는가 |
| 현재 활동 질문 | 현재 상태 없음/유효/만료를 다른 case로 표시 | 모르는 현재 활동을 과거 설정에서 만들지 않는가 |
| 정정·망각 | 무효 archival source 제외와 Core/Summary/history 잔존을 구분 | 정정된 사실 반영, 직간접 재노출 여부 |
| 지적 후 복구·긴 흐름 | 반복 실패와 경과 기록 | 문맥 복구, 적절한 질문, 자연스러운 한국어, 화제 다양성 |

- 기존 22개 코멘트를 실패 의미의 기준으로 유지한다. 동일 문구만 외워 통과하지 않도록 표현을
  바꾼 미사용 case를 미리 분리하고 mapping/selector 조정에 사용하지 않는다. tuning case와
  holdout의 결과를 따로 보고하며 holdout을 보고 수정했다면 새 holdout이 필요하다.
- 무료 구조 확인 뒤 소규모 모델 smoke, 이후 비교할 case마다 최소 3회 반복한다. 실제 호출 수와
  비용 상한은 실행 계약에서 정한다. 같은 seed를 공급해도 동일 출력이 보장됐다고 쓰지 않는다.
- 동일 prefix의 국소 응답 비교와 긴 대화 평가는 분리한다. 긴 대화에서 각 조건은 자기 history를
  이어가며 출발 hidden state와 scripted 사용자 흐름은 같다. simulator가 다른 사용자 발화를
  만든 결과는 흐름 관찰 자료로 표시하고 동일 입력 효과로 합산하지 않는다.
- 사용자에게는 같은 캐릭터의 조건만 가린 후보를 무작위 좌우 순서로 보여준다. 원문을 캐릭터
  이름 제거용으로 재작성하지 않는다. 두 후보에 같은 중립적인 Persona brief를 제공한다.
- source badge, injection 수, 모델/조건 이름은 최초 판단 뒤 확인한다. 먼저 보여 주면 구조를
  잘 지킨 후보를 좋은 답변으로 선택하도록 유도할 수 있다.
- 매 pair에 선호/동률/둘 다 부적절과 원문 근거를 기록하고 문맥 연결·개성·회상·한국어를 함께
  본다. 캐릭터×case별 win/tie/loss와 결함 건수를 반복 수와 함께 보고한다. 작은 표본을 통계적
  확증이나 전체 사용자 선호로 일반화하지 않는다.
- 구조 gate는 누락·잘못된 주입을 판정한다. 한 캐릭터의 개성 소실, 필요한 회상 실패, 무효 기억
  노출 등 회귀가 있으면 전체 평균 개선으로 덮지 않는다. 원인 수정·재검수 전 적용 후보가 아니다.
- 품질 판정은 기존 결정대로 사용자 1인이 한다. 추가 reviewer 모집이나 2인 calibration 재개는
  요구하지 않는다. 조건 가림 여부와 1인 검수 provenance를 기록하고 gold로 승격하지 않는다.
- source가 prompt에 들어갔다는 사실과 답변에서 사용됐다는 해석을 분리한다. ID trace는 전자만
  증명한다. 후자는 원문 검수 근거 또는 명시적 source 제거 비교로 평가하며 자동 확정하지 않는다.

### 10.5 결과에 따른 다음 행동

- routing 진단에서 개선되고 실제 selector에서도 유지됨: 해당 효과와 회귀 근거를 사용자 검수에 올린다.
- 사전 선택 진단만 좋음: 입력 선택 문제를 먼저 해결한다. Router 성공으로 서비스에 적용하지 않는다.
- 불필요 소재는 줄지만 캐릭터성·회상이 저하됨: 분류 단위와 identity/voice 보존을 재검토한다.
- Persona 비교가 무효과/혼재: canon 중복과 지침·배치의 경쟁 가설을 조사한다. 임의로 정책·필드 수를 늘리지 않는다.
- 적절한 context에서도 한국어·대화 행동이 어색함: source 표현, 공통 지침, 모델 비교를 개별
  실험으로 제안한다. 모델 차이를 입력 구조의 효과와 섞지 않는다.

## 11. 실행 순서와 경계 (2026-09-07 수정)

이 절이 다음 작업의 계획 정본이다. 기존 P1-0/1 결과는 보존하며 후속 구현과 비용이 드는 실행은
각 단계의 구체적 입력·변경 파일·호출량이 준비된 뒤 기존 승인 경계를 따른다. 계획 수정 이후
사용자의 후속 진행 요청으로 S1 조사를 수행했다. 최초 원문 저장 요청은 자동 승인 검토에서
거부됐으나 사용자가 해당 경로의 저장·분석을 명시적으로 승인한 뒤 snapshot과 전수 조사표를
생성했다. 이어 승인된 혼합 블록 8개/22구간의 실험 입력 분리를 구현·검증했다. 전체 실행용
mapping·제품 routing 적용·반복 본 비교는 미실행이다.
후속 examples 검토에서는 4개 블록의 54개 문답을 조사하고, 원문 / 혼합 분리 / 혼합 분리에서
예시만 미주입하는 A/B/C 입력과 96건의 준비 검사를 마쳤다. C는 로컬 비교 후보이며 제품 정책은 유지한다.
이후 기존 HTTP target에 고정 Persona·clock을 연결하고 같은 캐릭터 review 패킷을 구현했다.
별도 CLI 합성 응답 96건과 회귀 검증을 통과했다. 사용자가 안내한 DB에서 현재 모델 설정을
확인하고 12회 인사 smoke의 입력·요청 설정·비용 추산을 제시했다. 후속 사용자 승인으로 실제
모델 12회가 완료됐으며 청구액은 $0.020053869다. 사용자 원문 검수와 반복 본 비교는 남아 있다.

### 11.1 범위와 결정 기록

| ID | 분류 / 근거 | 상태 | 현재 처리 |
| --- | --- | --- | --- |
| D1 | in-scope / `user-confirmed` | active | 공통 경로 개선, 사용자 원문 검수, 캐릭터별 runtime 예외 금지 |
| D2 | preserve-current-behavior / `repo-evidenced` | active | ADR 0008의 네 경로와 legacy fallback, DB 원문·schema 유지 |
| D3 | in-scope / `agent-assumed` | active | 아래 순서를 가역적인 연구 계획으로 채택. 성능 효과는 미확정 |
| D4 | in-scope / `repo-evidenced` | active | 개발 DB 접속·활성 4/45/79와 격리 snapshot 확인. hash로 원문 불변성을 검증. Memory 기존 type을 adapter가 읽지 않는 사실 확인 |
| D5 | deferred / `recommended-unconfirmed` | deferred | greeting의 제품 변경, examples 최종 정책, selector 방식·threshold는 해당 단계에서 결정. 혼합 분리는 D9, 예시 진단 입력은 D10으로 이동 |
| D6 | deferred / `recommended-unconfirmed` | deferred | Current State 정본·만료 정책, Bond/말투 제품 동작, 모델 교체는 비교 근거 뒤 결정 |
| D7 | 계획 수정 턴 한정 / `user-confirmed` | superseded | 당시 계획 수정만 진행. 후속 진행 범위는 D8로 대체 |
| D8 | in-scope / `user-confirmed` | active | 지정된 ignored 경로에 캐릭터 설정·Persona·Memory snapshot 저장 및 S1 조사 승인·완료. 실제 사용자 데이터·인증 정보 제외 |
| D9 | in-scope / `user-confirmed` | complete | 혼합 블록 8개의 원문 22구간을 실험 입력에서만 분리하도록 승인·구현·검증. 다른 37개·examples·canon 유지. examples 변경은 별도 후속 결정 |
| D10 | in-scope / `agent-assumed` | active | examples 54문답 조사와 A/B/C 진단 입력 준비. C의 네 ID 미주입 후보는 제품 정책으로 채택하지 않음. 모델 smoke 실행은 D12 |
| D11 | in-scope / `user-confirmed` | implementation-complete | 기존 모델 경로의 고정 입력 비교와 1인 review 연결·검증 완료. 유료 smoke 실행은 D12 |
| D12 | in-scope / `user-confirmed` | execution-complete / review-pending | DB 모델로 12회, 최대 출력 8192, 재시도 0의 실행안을 승인받아 완료. 청구액 $0.020053869, 실제 검증 32개 통과. 5개 제공사가 섞여 인과 해석 제한. 288회 확대는 포함하지 않음 |

계획 문서 수정 당시 blocking decision은 0개였다. 실제 source 조사 뒤 S2 준비의 첫 결정으로
D9가 구체화됐고 후속 승인으로 완료했다. D5/D6는 나머지 후속 결정을 보류한 기록이며 확정 정책이나 구현 승인이 아니다.
작은 첫 실험에 필요하지 않은 상태 모델·그래프·새 인프라는 구현 목록에서 제외한다.

### 11.2 완료된 기반

- [x] **P1-0:** Memory seed/provenance 구현. 합성 무효 기억의 top-K 주입은 기준선 실패로 보존.
  [결과](reports/character-chat-p1-0-memory-fixture-provenance-2026-09-07.md)
- [x] **P1-1 구조:** strict ID manifest와 Router 구현. 합성 2인×3턴의 source 배치는 검증됐으나
  실제 모델 품질·실제 selector·실제 캐릭터 매핑은 미검증.
  [결과](reports/character-chat-p1-1-persona-router-2026-09-07.md)

### 11.3 다음 최소 단계 — source 조사와 Persona 효과 검증

2026-09-07 S1 결과: 활성 캐릭터 4명, 미삭제 Persona 45개와 character memory 79개.
Persona 원문은 총 16,375자, Memory 원문은 총 4,536자다. legacy greeting 제외 4개,
실제 stable 후보 41개, 빈 Persona 0개를 집계했다. Memory type은 event 26 / fact 13 /
goal 7 / preference 16 / relationship 3 / routine 14이며 `auto:` reason은 event 1개뿐이다.
따라서 `auto:`만으로 사건·과거 lore를 식별하는 가정은 사용하지 않는다. 이후 원문 전수 조사에서
33개 block의 보수적 route 후보와 혼합 목적 8개·examples 4개 미확정 항목을 기록했다.
원문 분리 주석은 8개/22구간이며 사용자 승인 후 평가 입력에 적용했다. 원문 그대로 재조립되며
11개 `always` / 8개 `never_prompt` / 3개 `retrieved`로 배치된다. source 분리와 전체 mapping 완성을
구분한다. [S1 보고서](reports/character-chat-s1-source-audit-2026-09-07.md)에 근거·한계를 기록했다.

- [x] **S1 / source 조사:** 격리된 활성 snapshot에서 블록별 목적, 혼합 내용, canon과의 중복,
  greeting의 proactive/reactive 구분을 기록한다. count만 같다고 이전 snapshot과 동일하다고
  보지 않는다. manifest와 원문은 git 밖에 두며 미분류·충돌 목록을 먼저 검토한다.
  소유자: `src/persona/postgres-persona-store.ts`, `src/persona/routed-persona-store.ts`.
  검증 결과: 읽기 전용 count/hash, 45/79 전수 조사 연결, ID 누락·중복, 원문 불변성을 확인했다.
  조사 당시 미확정 12개 중 혼합 8개는 아래 단계에서 처리했고 examples 4개는 후속 결정으로 남는다.
  전체 실행용 manifest와 제품 parser 검증은 S2 입력 확정 뒤 수행한다.
  혼합 블록을 억지로 한 route에 넣은 상태를 완전한 매핑으로 판정하지 않는다.
- [x] **S1 후속 / 승인된 혼합 원문 분리:** `evals/persona-source-projection.ts`와
  `eval:persona-projection`으로 8개/22구간을 실험 입력에만 적용했다. 37개 원본 블록과 examples
  4개·canon 79개는 그대로다. 원문 hash·전체 byte 범위·UTF-8 경계·ID 충돌을 검증하며 기존 Router가
  배치를 소유한다. 실제 source의 4명 × 3조건과 합성 `ChatService.prepare` 통합 검증을 통과했다.
  실제 selector·모델 호출은 포함하지 않으며 source snapshot과 출력은 gitignore 경로에만 둔다.
- [x] **S1 후속 / examples 검토와 국소 비교 입력:** 4개/54문답을 검토했다. examples 유지와
  미주입을 같은 혼합 분리 입력에서 비교하도록 C 조건을 별도로 준비했다. 원문을 고치거나 좋은
  문답만 선별하지 않는다. 4명 × 8상황 × 3조건의 준비 96건 통과, 모델/embedding 호출 0회.
  [검토·입력·실행 경계](reports/character-chat-s1-examples-review-2026-09-07.md)
- [x] **S2 준비 / 기존 실제 모델 경로 연결:** `eval:persona-comparison`이 pinned Persona/case
  manifest와 기존 target의 HTTP/provider 경로를 사용한다. fresh target, 고정 clock, 선택 0,
  Bond/Memory 미추적, 호출 상한과 재시도 0, 응답 우선 저장을 검증했다. 실제 source CLI 합성
  completion 96건·외부 모델 0회. A↔B/B↔C 패킷은 같은 캐릭터·prefix이며 원문을 유지하고
  조건만 가린다. 사용자 1인 검수 후 판단하며 기존 2인 agreement 집계로 품질 PASS를 만들지 않는다.
  DB의 현재 모델 설정과 12회 smoke 비용·입력 계약은 위 보고서에 기록했다.
- [x] **S2 smoke / 첫 실제 모델 응답:** 인사 1상황 × 4명 × 3조건을 사용자 승인 후 실행했다.
  12회 모두 정상 종료, prompt/source와 고정 설정 일치, 같은 캐릭터·prefix 검수 8쌍을 확인했다.
  실제 생성 12회와 청구액 조회 GET 12회를 구분한다. 결과와 제한은 위 보고서에 기록했다.
  제공사가 5개로 나뉘고 reasoning 보고값도 달라, 모델명 고정만으로 통제된 품질 비교가 되지 않는다.
- [ ] **S2 / 반복 국소 모델 비교:** S1에서 명확히 분류 가능한 입력으로 10.3의 Legacy / 사전 선택
  Routed를 같은 모델에서 비교한다. 미분류가 남은 캐릭터는 제한을 표시하고 전체 완료로 세지
  않는다. 모든 source와 hidden state, 재생 prefix를 고정하며 selector 원리와 진단 한계를 적는다.
  첫 제한 실험은 준비된 A↔B(혼합 분리), B↔C(examples 노출)로 요인을 구분할 수 있다.
  A↔C만으로 효과를 합쳐 주장하지 않는다. 이때 전체 mapping과 실제 selector 완성을 선행 조건으로
  강제하지 않으며, 선택 0의 국소 진단을 필요한 lore 회수 성공이나 전체 Routed A/B로 세지 않는다.
  소유자: `evals/target.ts`의 기존 실제 모델 경로, 이를 호출하는 `evals/persona-comparison.ts`와
  `evals/persona-comparison-cli.ts`, 기존 `evals/review.ts`,
  `src/bootstrap/container.ts`의 Store/selector override. `evals/persona-router-eval.ts`의
  FakeProvider 결과를 실제 모델 결과로 포장하거나 별도 채팅 엔진을 만들지 않는다.
  검증: `npm run eval:persona-router`는 구조 회귀만, `npm run test:eval`은 평가 계약 회귀만
  담당한다. `eval:persona-comparison -- run`으로 첫 12회 smoke를 완료했으며 원문 검수가 남아 있다.
  자동으로 288회로 확대하지 않는다. 본 비교 전 OpenRouter의 제공사와 reasoning 조건을 고정하고
  실제 응답 metadata로 확인해 provider 차이를 Persona 효과와 혼동하지 않는다.
- [ ] **S3 / 실제 선택과 일반화:** S2의 이득이 확인되면 `PersonaBlockSelector` 경계에 공통
  선택기를 연결한다. 입력의 최신 문장만으로 지시어가 해소되지 않는 경우를 포함해 검증하고,
  `never_prompt`는 selector에도 전달하지 않는다. 선택 실패·무관 질의는 optional lore 없이
  진행하되 필요한 회상 실패를 성공으로 세지 않는다. 상세 selector 방식은 S1/S2 증거 뒤 확정한다.
  소유자: `src/chat/chat-service.ts`, `src/persona/persona-router.ts`, 해당 테스트와 `evals/target.ts`.
  검증: 해당 source 테스트, `npm run test:eval`, holdout 실제 모델 재생. snapshot·mapping·
  selector 버전을 동결하고 10.4의 캐릭터별 회귀 여부를 확인한다.
- [ ] **S4 / 원문 검수:** S2와 S3 각각 결과가 나오는 시점에 사용자가 비교한다. 모든 후속 기능을
  만든 뒤 한 번에 검수하는 마지막 단계로 미루지 않는다. 기존 `evals/review.ts`의 pair/제출
  계약을 재사용하되 2인 agreement 집계로 1인 검수를 강제 통과시키지 않는다. 같은 캐릭터의
  조건 가림과 원문 보존에 필요한 최소 adapter/UI만 다음 구현 계약에 포함한다.
  검증: `evals/review.test.ts`의 관련 회귀와 실제 artifact의 좌우 가림·동률·양쪽 실패·원문 확인.

### 11.4 증상에 따라 선택할 후속 실험

이 목록은 순서대로 모두 구현할 작업이 아니다. 다음 항목은 S2/S3 결과가 가리키는 원인 하나를
선택한다. 각각의 실제 모델 재생 전에 관련 단위 테스트와 `npm run test:eval`을 수행한다.

| 후보 | 바꿀 한 가지와 소유자 | 검증·진행 조건 |
| --- | --- | --- |
| Character lore 선별 | `src/persona/postgres-persona-store.ts` read 결과와 `src/chat/system-prompt.ts`의 canon 경로 | 먼저 DB의 기존 `id/type/reason/created_at/updated_at`을 조사하고 새 schema 필요성을 판단. type 단독으로 route·만료를 확정하지 않음. 중복 source나 과거 사건 문제가 재현되면 같은 원문·핵심 canon을 보존하는 별도 비교. 현재 `canonMemories: string[]`에는 ID 추적된 선별이 없음 |
| 사용자 Memory 유효성 | `src/memory/retrieval.ts`, Store와 `evals/cases/p1-memory-structure.json` | fixture 상태별 제외/허용 검증. 검색 제외만으로 저장·정정·완전한 망각 구현을 완료 처리하지 않음 |
| 사용자 Memory 관련성 | 같은 scorer와 `src/chat/chat-service.ts` | 상태 필터를 고정하고 raw relevance/empty를 비교한 뒤, 필요하면 별도로 query 문맥 확장 비교. 미사용 positive/negative case에 threshold를 조정하지 않음 |
| Context 순서 | `src/openai/messages.ts`와 해당 테스트 | 내용은 고정하고 context/user text 순서만 비교. 짧은 후속 발화, 사용자 text 보존, prompt 안정성과 token·지연도 확인 |
| 시간·Bond 지침 | `src/chat/turn-context.ts`와 해당 테스트 | 무관 시간 언급 또는 질문·자기 노출 문제가 남을 때 문구 한 요인씩 비교. 관계 정책 변경은 별도 결정 |
| 현재 상태 | turn context의 격리 fixture | 유효한 사실 공급 효과와 상태 없음/만료 시 절제를 비교. 정본 공급자·갱신·만료 정책을 결정하기 전 DB화하지 않음 |
| 한국어·대화 행동 | `src/chat/system-prompt.ts`, `evals/target.ts` | 올바른 입력에서도 결함이 남으면 원문 품질·지침·모델을 각각 비교. 새 상태 머신·fine-tuning은 자동 후속 작업이 아님 |

사용자 Memory와 Persona 결합 효과를 볼 필요가 생기면 기존 2×2를 재사용한다. 이때 Memory는
`agent_archival_memories` 검색만 의미하며 character canon, Core/Summary와 혼동하지 않는다.
A=Legacy+기존 검색, B=Routed+기존 검색, C=Legacy+검증된 gate, D=Routed+검증된 gate다.
네 조건에 같은 사용자 seed와 hidden state를 주며 이후 변경된 기준선을 과거 결과와 섞지 않는다.

### 11.5 구현·적용 경계와 소유자 확인

현재 라우팅은 `routePersona`와 strict `RoutedPersonaStore`, 관련성 선택은
`ChatService.selectPersonaBlocks` 및 `ContainerOverrides.personaBlockSelector`가 기존 경계를
소유한다. 실제 모델 평가는 `evals/target.ts`→`evaluate.ts`→`cli.ts`, 검수는 `review.ts`를
확장한다. 심볼 정의와 호출부 두 신호로 확인했으며 모두 `owner-found`다. 새로운 공통 엔진이나
Context Orchestrator 계층은 필요하지 않다. character lore의 ID 기반 선별처럼 현재 없는 기능은
해당 slice에서 별도 Existing Owner Check를 거쳐야 한다.

DB schema 승격은 효과가 확인됐다고 자동 실행하지 않는다. 실제 선택 경로·holdout·긴 대화
검수와 회귀 확인을 거친 뒤 필요한 최소 field만 schema owner `opod-service-backend`에
제안한다. 정확한 DDL 대상·호환성·rollback을 별도 승인받는다. 적용은 기존 legacy 경로로 되돌릴
수 있어야 하며, 새 feature flag나 영구 설정 체계를 미리 추가하지 않는다.

## 12. 채택하지 않을 접근

- Character.AI의 32K 한도를 보고 Persona를 더 길게 쓰는 것
- 캐릭터별 금칙어와 정답 문장을 shared prompt에 누적하는 것
- 게시물에서 얻은 사건을 영구 current state로 쓰는 것
- `최근 N개`만으로 relevance와 expiry를 대체하는 것
- top-K를 항상 채워야 좋은 memory라고 판단하는 것
- Summary를 사실 정본으로 사용하고 사용자가 고칠 수 없게 하는 것
- Persona와 Memory를 동시에 바꾼 한 번의 결과만으로 원인을 단정하는 것
- 모델 temperature 변경을 구조 개선으로 부르는 것
- LLM judge의 유창성 점수로 사용자의 “뜬금없다” 판정을 덮는 것
- 한 캐릭터에서 좋아진 prompt를 다른 모든 캐릭터의 정답으로 복사하는 것

## 13. 재검토 결론

입력의 용도·관련성·유효성을 구분하는 방향과 사용자 원문 검수 중심의 평가는 유지한다.
수정한 부분은 원인 확정의 강도, Persona/canon/사용자 기억의 실험 경계, 실제 selector 검증,
캐릭터성 손실 방지, 조건 가림, 결과에 따른 중단·분기 기준이다.

재검토 이후 source 조사·원문 분리·첫 실제 모델 smoke를 완료했다. 다음은 원문 검수와
제공사/reasoning 조건을 통제한 반복 비교다. 세 구조를 모두 만드는 것은 성공 조건이 아니다. 공통 코드에서 사용자 경험의 개선을
확인한 변경만 적용 후보로 남긴다. 이 수정은 연구 계획이며 새 제품 정책이나 DDL 승인으로
승격하지 않는다.
