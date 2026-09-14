# 캐릭터 챗 아키텍처·페르소나·메모리 연구

- 작성일: 2026-09-02
- 상태: 설계 연구 및 개선 권고안
- 대상: OPOD 캐릭터 DM 전체와 개발 DB의 모든 활성 캐릭터
- 후속 실행 계획: [`character-chat-p0-baseline-plan-2026-09-02.md`](character-chat-p0-baseline-plan-2026-09-02.md)
- 관련 선행 문서: [`dogeon-persona-improvement-2026-08-31.md`](dogeon-persona-improvement-2026-08-31.md), [`long-conversation-eval.md`](long-conversation-eval.md), [`persona-memory-plan.md`](persona-memory-plan.md)
- 경쟁 제품 후속 조사: [`character-chat-products-persona-memory-research-2026-09-03.md`](character-chat-products-persona-memory-research-2026-09-03.md)

## 1. 결론

사람 같은 캐릭터 챗은 좋은 페르소나 문구 하나로 만들어지지 않는다. 사용자의 방금 말에
정확히 붙는 반응, 캐릭터도 자기 몫을 내놓는 상호성, 대화가 진행되는 상태, 필요할 때만
꺼내는 기억, 관계와 한국어 높임말의 연속성이 함께 작동해야 한다.

OPOD에는 이미 좋은 기반이 있다. Persona/Memory의 서비스 경계, 비동기 consolidation,
Archival/Core/Summary 계층, 실제 API 경로를 통과하는 H30 평가 하네스가 존재한다. 현재
품질을 막는 핵심은 기반의 부재보다 **서로 다른 종류의 정보를 한 프롬프트에 너무 많이
넣고, 관계와 기억을 지나치게 단순한 상태로 모델에 전달하며, 실제 사용자 기준으로
평가를 보정하지 않은 것**이다.

따라서 권장 순서는 다음과 같다.

1. P0에서 현재 모델·sampling·Persona·Memory 상태를 고정하고 실패를 재현한다.
2. P1에서 prompt/context 순서, Persona 채널 분리, 대화 상태, 관계·말투, Character World
   State를 바로잡는다.
3. P2에서 기억의 생성·수정·망각·회수 전 생애주기와 provenance를 갖춘다.
4. P3에서 dialogue move와 전송 UX를 실험한다.
5. 위 문제가 해결된 뒤에만 P4 fine-tuning을 검토한다.

Fine-tuning을 먼저 하면 현재의 질문 공세, 슬로건 반복, 강제 회상 같은 결함을 데이터에
굳힐 가능성이 크다. 반대로 P0는 답변을 바로 바꾸는 단계가 아니다. 무엇을 고쳐야 하는지
판별 가능한 baseline을 만드는 단계다.

### 1.1 개선 소유 원칙

이 연구와 후속 구현의 소유 단위는 개별 캐릭터가 아니라 **공통 채팅 엔진, 공통 Persona/Memory
계약, 공통 평가 체계**다. 특정 캐릭터에서 먼저 드러난 증상은 재현 probe일 뿐 해결책의 소유자가
아니다.

- 공통 코드에 운영 캐릭터 ID·이름을 조건으로 한 분기를 두지 않는다.
- 운영 캐릭터의 Persona·canon·고유 상황은 runtime data 또는 fixture가 소유한다.
- 공통 baseline은 같은 시나리오를 대상 캐릭터 집합 전체에 실행한다.
- 한 캐릭터만 좋아지고 다른 캐릭터가 악화되면 전체 개선으로 판정하지 않는다.
- 캐릭터별 추가 probe가 필요해도 공통 rubric과 합격 의미를 바꾸지 않는다.

## 2. 근거의 종류와 확정 범위

이 문서는 근거를 세 종류로 구분한다.

| 표기 | 뜻 | 예시 |
| --- | --- | --- |
| 저장소 근거 | 현재 checkout에서 직접 확인한 구현·데이터 흐름 | 모든 active Persona block 로드, 최근 사용자 문장만 retrieval query로 사용 |
| 개발 DB 근거 | 개발 서버의 읽기 전용 집계와 LLM 로그 | 활성 4명 전체의 Persona/character memory와 실제 prompt 구성 |
| 외부 근거 | 논문·공식 문서에서 반복 확인되는 설계·평가 원리 | 계층형 기억, 전체 대화 pairwise 평가, sensibleness/specificity |
| 권고 | 위 근거로부터 OPOD에 적용한 설계 판단 | Character World State 도입, 실제 사용자 발화를 dynamic context 뒤에 배치 |

이 문서는 코드·DB·Admin 데이터 변경을 승인하거나 확정하지 않는다. 특히 2026-07-21의
[`persona-memory-plan.md`](persona-memory-plan.md)는 당시의 결정 기록이다. 이 연구가 그
문서의 “전 canon 주입 유지” 같은 가정을 재검토 대상으로 올리지만, P0 측정 전 기존 결정을
조용히 덮어쓰지는 않는다.

## 3. “자연스럽다”의 운영적 정의

자연스러움은 문법 오류가 없는 상태도, 친절한 상태도 아니다. 실제 DM에서는 다음 여섯
속성이 함께 보여야 한다.

### 3.1 국소 적합성(local contingency)

답변이 대화 일반론이 아니라 사용자의 **바로 전 표현, 함의, 감정 온도**에 붙어야 한다.
“그건 왜?”, “아니 그거 말고”, “됐어” 같은 짧은 후속 발화는 최근 몇 턴을 묶어 이해해야
한다. 최신 사용자 문장 하나의 embedding이나 오래된 요약만으로는 부족하다.

### 3.2 상호성(mutuality)

사람은 계속 질문만 하지 않는다. 맞장구를 치고, 자기 하루를 조금 내놓고, 의견을 보이고,
농담을 받아치고, 때로는 질문 없이 여백을 둔다. 질문 비율을 낮추는 규칙만으로는 부족하다.
`ACK → SHARE`, `ANSWER → TEASE`, `REPAIR → CLOSE`처럼 캐릭터도 대화에 기여해야 한다.

### 3.3 리듬과 변이

매 답변이 `인정 → 깔끔한 정리 → 질문`으로 끝나면 문장 하나하나는 좋아도 챗봇처럼
느껴진다. 길이, 문장 시작, 질문 여부, 유머와 자기 노출의 빈도가 상황에 따라 달라져야 한다.
Production examples도 독립 모범답안 목록보다 짧은 다중 턴 궤적이어야 한다.

### 3.4 상태성(statefulness)

자연스러운 대화에는 현재 주제, 열린 질문, 직전의 오해, 조언 허용 여부, 감정 변화,
말투가 있다. 캐릭터에게도 “지금 무엇을 하던 중인지”가 있어야 한다. 이 상태가 없으면
`뭐 해?`에 매번 그럴듯하지만 서로 모순되는 일을 지어낸다.

### 3.5 기억의 절제(memory discretion)

기억을 많이 보여주는 것이 친밀함은 아니다. 관련 없는 과거 사실을 먼저 꺼내면 감시받는
느낌이 난다. 좋은 기억 시스템은 회상뿐 아니라 **이번에는 아무것도 회수하지 않는 선택,
정정된 사실을 버리는 선택, 민감한 내용을 저장하지 않는 선택**을 할 수 있어야 한다.

### 3.6 복구 능력(repair)

사람 같은 대화는 한 번도 틀리지 않는 대화가 아니라, `그 뜻 아니었어`, `질문 좀 그만해`,
`아까 미안`을 받은 뒤 짧게 방향을 바꾸는 대화다. 이 능력은 single-turn 정답률보다
다중 턴 평가에서 더 잘 드러난다.

## 4. 목표 아키텍처

### 4.1 한 턴의 권장 경로

```text
사용자 메시지
    │
    ▼
Context / State Builder
    ├─ 최근 raw turns
    ├─ 현재 intent · affect · topic · open loops
    ├─ relationship · Korean register
    ├─ Character World State
    └─ 관련성 기준을 통과한 기억만
    │
    ▼
Dialogue move 선택
ACK · ANSWER · SHARE · ASK · TEASE · REPAIR · CLOSE
    │
    ▼
기본 1회 생성
    │
    ▼
경량 검증
형식 · 안전 · 반복 · 기억 근거 · 종료 의사
    │
    ├─ 정상 → 전달
    └─ 심각한 위반만 제한적 재생성

전달 후 비동기
Capture → Classify → Merge/Supersede/Ignore → Reflect → Expire/Audit
```

기본값은 planner LLM과 writer LLM을 매 턴 두 번 호출하는 구조가 아니다. 짧은 DM의 지연과
비용을 고려해 dialogue move는 규칙·작은 분류기·동일 생성 호출의 구조화된 내부 지시 중
가장 단순한 것으로 시작한다. 복잡한 갈등 복구나 도구 사용처럼 가치가 있는 턴만 별도
planning을 허용한다.

### 4.2 컨텍스트는 수명과 책임별로 분리한다

| Artifact | 무엇을 담는가 | 수명 | 기본 주입 방식 | 정본/소유자 |
| --- | --- | --- | --- | --- |
| Identity kernel | 정체성, 핵심 voice, 가치, 안전 경계 | Persona version | 매 턴, 짧고 안정적인 prefix | Admin Persona |
| Character lore | 직업·관계·취향·세계관 사실 | 장기 | 관련 lore만 retrieval, 소수 핵심만 상시 | Admin character memory |
| Character World State | 오늘의 활동, 위치, 진행 중 사건, 최근 게시 맥락 | 시간~일 | 현재 유효한 상태만 | 콘텐츠/이벤트 파이프라인 |
| User semantic memory | 선호, 사람, 장기 프로젝트 | 장기 | 관련성·동의·신뢰도 통과 시 | Agent relationship memory |
| User episodic memory | 특정 사건과 시점 | 중기 | 시간·상태 필터 후 retrieval | Agent relationship memory |
| Relationship state | 친숙함, 온기, 신뢰, 장난 허용도, 말투 | 장기+최근성 | compact state | Agent relationship state |
| Conversation state | 현재 주제, open loop, 감정, 조언 허용, repair | 세션 | 매 턴 compact state | Agent session state |
| Recent transcript | 실제 최근 발화 | 분~시간 | 원문 window | service-backend/Agent contract |

Persona, lore, 현재 사건, 사용자 기억을 모두 “memory” 또는 “system prompt” 한 종류로 다루면
오래된 게시 사건이 영구 canon이 되거나 사용자 사실이 캐릭터의 신념처럼 작동한다.

### 4.3 권장 컨텍스트 순서

의미상 다음 순서를 권장한다.

```text
1. safety / product contract
2. compact identity kernel
3. Character World State
4. relationship + Korean register
5. current conversation state / open loops
6. relevant memories
7. recent raw turns
8. 사용자가 방금 실제로 쓴 문장
```

현재 OPOD는 cache-stable system prefix를 위해 dynamic context를 최신 user message의 **실제
발화 뒤에** 붙인다. Prefix cache를 지키는 목적은 타당하지만, 실제 발화보다 Memory/Bond가
모델에 더 최근 지시로 읽힌다. 권고안은 stable system prefix를 유지하면서, 최신 user
message 내부에서는 `<context>…</context>` 다음에 별도 구분자를 두고 실제 사용자 문장을
마지막에 놓는 A/B를 먼저 한다. 최신 message 자체는 매 턴 새로 생기므로 이 순서 변경이
그 이전 history prefix cache까지 무효화하는지 측정해야 하며, 성능과 품질을 함께 비교한다.

## 5. Persona 설계

### 5.1 Persona는 설정집이 아니라 의사결정 경향이다

자연스러운 캐릭터는 특정 단어를 자주 쓰는 캐릭터가 아니다. 같은 상황에서 무엇을 먼저
보고, 무엇을 숨기고, 어떤 방식으로 관계에 기여하는지가 일관된 캐릭터다.

Persona의 상시 kernel에는 다음만 남기는 것이 좋다.

- 정체성: 누구이며 어떤 삶을 사는가
- voice: 문장 길이, 직접성, 유머, 정서 표현 방식
- values: 선택이 충돌할 때 무엇을 우선하는가
- boundaries: 안전, privacy, 메타 노출, 관계 경계
- social tendencies: 낯선 사람·친한 사람·갈등·칭찬·침묵에서 보이는 경향

촬영 프롬프트용 `capture_style`, 게시물용 `content_style`, 운영자용 제작 지침은 DM 답변
policy와 다른 채널이다. 제목 이름에 의존해 모두 주입하기보다 소비 채널을 명시적으로
타이핑해야 한다.

### 5.2 행동은 trait × situation × relationship으로 쓴다

`항상 자신감 있게 말한다` 같은 절대 규칙은 모든 감정을 같은 톤으로 만든다. 다음과 같은
행동 행렬이 더 유용하다.

| 상황 | 낯선 관계 | 익숙한 관계 | 가까운 관계 |
| --- | --- | --- | --- |
| 칭찬 | 짧게 그대로 받음 | 가벼운 농담을 섞음 | 상대에게 되받아칠 수 있음 |
| 속상함 | 함부로 해석하지 않음 | 직전 맥락을 짚어줌 | 요청되면 더 솔직한 의견을 냄 |
| 도발 | 경계를 지키며 담백하게 받음 | 작은 승부욕을 보임 | 공유된 농담과 shorthand 사용 |
| 침묵/단답 | 한 번 공간을 줌 | 자기 얘기로 부담을 나눔 | 말없이 함께 있는 느낌도 허용 |

규칙은 `ALWAYS/NEVER`보다 경향과 예외를 함께 쓴다. 단, 안전·개인정보·내부 시스템 노출
같은 경계만 hard constraint로 유지한다.

### 5.3 Examples는 답안지가 아니라 대화의 궤적이다

개발 DB의 예시 블록은 캐릭터에 따라 양이 다르지만 대체로 독립적인 단문 문답 중심이다.
특정 캐릭터에서 27개 단문 예시가 특히 크게 드러났을 뿐, 완결된 모범답안이 많아질수록 모델이
상황별 FAQ를 고르고 모든 답변을 비슷한 리듬으로 닫는 문제는 전체 Persona 작성 방식에 해당한다.

Production examples의 권장 조건은 다음과 같다.

- 6~10개의 짧은 다중 턴 장면
- 앞말에 따라 길이·온도·질문 여부가 변함
- 캐릭터가 자기 얘기를 조금 내놓는 장면 포함
- 오해·거절·사과 뒤 repair 포함
- exact 문구보다 선택 순서와 여백을 보여줌
- 평가용 edge case와 내부 메타 질문은 eval에 두고 prompt에 복사하지 않음

### 5.4 Persona와 lore를 분리한다

개발 DB의 활성 캐릭터는 Persona 9~12개와 character memory 13~25개를 갖고 있다. 중복 항목을
모두 상시 주입하면 짧은 인사에서도 수천 token의 prompt가 된다. 특정 캐릭터의 개수에 맞춰
최근 N개로 자르는 대신 정보의 책임과 수명으로 다음처럼 나눈다.

- Identity-critical canon: 이름, 직업, 핵심 관계, 바뀌면 캐릭터가 깨지는 사실
- Behavioral kernel: voice, values, boundaries
- Retrievable lore: 취향, 과거 사건, 세부 기록
- Dynamic world state: 최근 게시·오늘 일정·현재 활동

각 Persona release에는 version, block/channel 목록, token 수, 중복률, fingerprint를 남겨야
모델 변경과 Persona 변경을 구분할 수 있다.

## 6. Memory 설계

### 6.1 계층형 기억은 필요하지만 “저장”보다 생애주기가 중요하다

Generative Agents의 recency·importance·relevance와 reflection, MemGPT의 계층형 context는
유용한 출발점이다. 그러나 장기 대화 benchmark들은 단순 회상 외에도 다중 세션 추론,
시간 이해, 지식 갱신, 모르는 경우의 abstention을 요구한다. 운영 제품에는 수정·망각·감사
가능성까지 필요하다.

권장 생애주기는 다음과 같다.

```text
발화
  → capture 후보
  → explicit fact / inferred belief / relationship event / ephemeral 분류
  → 기존 기억과 비교
  → create / merge / supersede / ignore
  → retrieval 후보 생성
  → 관련성·시간·신뢰도·민감도 기준
  → 사용 또는 empty retrieval
  → correction / forget / expiry / audit
```

### 6.2 권장 memory record

```text
id
scope                 user × character / session / character-world
kind                  semantic / episodic / relationship / inference
subject, entities
content
source_turn_ids
source_speaker
confidence
salience
valid_from, valid_to
status                candidate / active / superseded / forgotten
supersedes_id
sensitivity
consent_state
created_at, last_used_at, use_count
embedding, lexical_keys
```

모든 필드를 곧바로 DB에 추가하자는 뜻은 아니다. P2에서 실제 실패가 요구하는 최소 필드부터
schema owner인 `opod-service-backend`와 함께 추가한다. 핵심은 관찰과 추론을 같은 확정 사실로
취급하지 않고, “민수”가 “민석”으로 정정됐을 때 이전 행을 검색 결과에서 배제할 수 있어야
한다는 것이다.

### 6.3 Retrieval은 순위가 아니라 통과 여부까지 결정해야 한다

권장 retrieval pipeline은 다음과 같다.

1. 최근 2~4턴, 현재 topic, open loop로 query를 만든다.
2. scope, kind, status, time validity, sensitivity metadata로 먼저 거른다.
3. dense vector와 lexical/entity match로 후보를 합친다.
4. relevance, recency, salience, confidence를 사용해 rerank한다.
5. absolute relevance floor와 token budget을 적용한다.
6. 한 종류의 기억이 결과를 독점하지 않도록 diversity를 적용한다.
7. 기준을 넘는 항목이 없으면 빈 결과를 반환한다.

Min-max 정규화 뒤 무조건 top-K를 반환하면 전체 후보가 무관해도 그중 가장 덜 무관한 항목이
선택된다. 사람 같은 절제에는 `top-K`와 별도로 `use none` 결정이 필요하다. 사용 후
`last_accessed_at`을 갱신할 때도 실제 답변에 활용된 기억과 단지 조회된 후보를 구분하지 않으면
같은 기억이 계속 후보 상단을 차지하는 feedback loop가 생긴다.

### 6.4 정정과 망각은 다르다

- 정정: 새 사실이 이전 사실을 supersede하고, 이전 사실은 provenance를 위해 남되 retrieval에서
  제외한다.
- 망각: 사용자 요청·보존 기간·민감도 정책에 따라 내용을 더 이상 사용하지 않고 필요하면
  물리 삭제한다.
- expiry: “오늘”, “이번 주”, “면접 준비 중” 같은 시간 제한 사실을 자동 비활성화한다.
- uncertainty: 캐릭터가 추론한 성향은 낮은 confidence로 두고 확정 사실처럼 말하지 않는다.

Core와 Summary를 한 문단으로 재작성하는 것만으로는 이 차이를 감사할 수 없다. 구조화된
record가 사실의 생애주기를 맡고, Summary는 대화 continuity를 위한 손실 압축으로 한정한다.

## 7. 관계 상태와 한국어 말투

### 7.1 하나의 XP level로 관계 전체를 잠그지 않는다

관계는 최소한 다음 축으로 분리하는 것이 좋다.

- familiarity: 서로에 대해 얼마나 아는가
- warmth: 현재 정서적 온기
- trust: 개인적인 내용을 다룰 수 있는 정도
- playfulness: 장난과 teasing 허용도
- register: 존댓말/반말 및 호칭 상태
- recency: 최근 연락 빈도
- unresolved tension: 사과·갈등·미완료 repair

현재 OPOD Bond는 깊이와 최근성을 분리한 점은 좋지만, 자기 하루를 먼저 말하는 것은 level
3, 반말은 level 4에서 열어 둔다. 그 결과 첫 대화에서 정상적인 상호성까지 금지되어
`질문 → 질문 → 질문`으로 흐를 수 있다. “처음 보는 사람에게 과도하게 친밀하지 않기”와
“처음 보는 사람도 자기 이야기를 한 문장 하는 것”은 별개다.

### 7.2 Korean register는 별도 state machine으로 본다

한국어의 존댓말/반말 전환은 친밀도 숫자 하나가 아니라 역할·나이·상대의 말투·명시적 제안·
상호 수용에 좌우된다. 권장 상태는 다음과 같다.

```text
polite_default
  ├─ user uses banmal → polite_relaxed 또는 mixed 관찰
  ├─ explicit request → transition_pending
  ├─ mutual confirmation → banmal
  └─ conflict / distance → polite_reset 가능
```

한 번의 반말을 곧바로 영구 전환으로 저장하지 않고, 호칭과 문장 종결형을 따로 관찰한다.
관계가 가깝더라도 캐릭터 설정상 계속 존댓말을 쓸 수 있고, 어린 사용자에게 무조건 반말하는
식의 단순 규칙도 피한다.

## 8. Character World State

“캐릭터도 자기 삶을 사는 느낌”은 Persona lore만으로 생기지 않는다. 현재 시각을 아는 것과
현재 무엇을 하는지는 다르다. 다음과 같은 작고 만료되는 상태를 콘텐츠·이벤트 정본에서
공급해야 한다.

```text
current_activity
location_or_context
energy_or_mood
active_event
recently_completed_event
source
observed_at
expires_at
confidence
```

예를 들어 어떤 캐릭터가 촬영이나 수업을 막 마쳤다는 게시 사건이 아직 유효하면 `뭐 해요`에
짧게 공유할 수 있다. 근거가 없으면 매번 새로운 사실을 canon처럼 만들지 않고, 시간대에 맞는
낮은 구체성의 답을 하거나 대화적으로 넘긴다. World State는 영구 Persona와 분리하고 expiry 뒤
retrieval에서 빠져야 한다.

## 9. 평가 전략

### 9.1 단일 답변 점수만으로는 부족하다

Meena의 sensibleness/specificity는 최소 기준을 제공하고, BlenderBot 계열 연구는 공감·지식·
Persona 같은 능력을 함께 본다. ACUTE-Eval은 전체 대화를 가린 pairwise 비교로 장기적인
engagingness와 humanness를 평가한다. OPOD도 세 층을 분리해야 한다.

| 층 | 무엇을 보는가 | 예시 |
| --- | --- | --- |
| Turn | 방금 말에 맞는가 | 의도 일치, 감정 조율, 원치 않는 조언, 형식 |
| Trajectory | 함께 말이 이어지는가 | 질문 공세, 상호성, repair, 말투 연속성, callback |
| System | 재현·운영 가능한가 | prompt token, latency, error, memory lifecycle, privacy |

### 9.2 자동 지표는 진단, 사람 평가는 기준점

자동으로 안정적으로 셀 수 있는 것은 길이, 질문 종결 비율, 질문 연속 횟수, 반복 문구,
latency, token, 빈 응답 등이다. “상담원 같다”, “자기 얘기가 적절했다”, “기억이 소름 끼치게
사용됐다”는 한국어 전체 맥락을 본 judge와 사람 검토가 필요하다.

LLM judge는 candidate와 다른 모델을 쓰고, turn 근거를 강제하고, good/bad/edge gold
transcript에 대해 사람과의 agreement 및 false-pass를 먼저 측정한다. 보정 전 숫자는 release
인증이 아니라 `provisional`이다. 현재 H30 문서도 이 원칙을 이미 명시한다.

### 9.3 권장 자연스러움 평가 축

- local relevance: 최신 표현과 함의를 놓치지 않는가
- mutuality: 캐릭터도 정보·감정·의견을 적절히 내놓는가
- rhythm: 길이와 dialogue move가 기계적으로 반복되지 않는가
- persona fidelity: 캐치프레이즈 없이도 그 인물인가
- advice restraint: 요청 전 해결책을 강요하지 않는가
- memory discretion: 정확하고 관련 있을 때만 회상하는가
- register continuity: 한국어 높임말·호칭 전환이 납득되는가
- repair: 지적·정정·종료 의사 뒤 즉시 방향을 바꾸는가

### 9.4 Fine-tuning의 위치

Fine-tuning은 다음 조건 뒤에 검토한다.

- 동일 입력에서 context 누락과 memory 오염을 분리할 수 있음
- 좋은/나쁜 다중 턴 한국어 대화와 사람 선호 label이 있음
- base model·sampling·Persona version이 고정됨
- prompt/context 개선만으로 얻을 수 있는 이득이 plateau에 도달함

학습 대상은 사실 자체가 아니라 대화 행동과 style이다. 최신 사건·사용자 사실·관계 상태는
외부 context에 남겨 수정과 삭제가 가능해야 한다.

## 10. 현재 OPOD 구현 리뷰

### 10.1 이미 잘 갖춘 것

- `PostgresPersonaStore`와 `MemoryStore` 경계가 있어 저장소와 조립 책임이 분리되어 있다.
- 사용자 기억은 Archival/Core/Summary로 나뉘고 consolidation이 응답 hot path 밖에서 돈다.
- idempotency, Summary CAS, 관계 단위 worker 직렬화 등 운영 안전 장치가 있다.
- H30은 8개 × 24 exchange, raw transcript, latency/token/tool event, 서로 다른 simulator/judge를
  요구한다.
- 선행 단일 캐릭터 개선안은 평가 probe와 production examples를 분리하는 유효한 초안을
  제공했지만, 공통 정책으로 검증되기 전에는 전체 설계 정본으로 사용하지 않는다.
- 현재 작업 트리의 system prompt 변경은 reactive reply에서 `greeting` block을 공통으로
  제외한다. 개발 배포 로그에는 아직 이 변경 전 prompt가 남아 있어 배포본 품질 근거로는
  사용할 수 없다.

### 10.2 품질 병목과 근거

| 우선도 | 현재 구현 | 사용자에게 보이는 위험 | 소유 코드 |
| --- | --- | --- | --- |
| 높음 | `greeting` 외 모든 active Persona block을 title 의미와 무관하게 verbatim 주입 | 게시·촬영용 지침이 DM 행동과 충돌, 긴 prompt | `src/persona/postgres-persona-store.ts`, `src/chat/system-prompt.ts` |
| 높음 | 모든 character memory를 매 턴 canon으로 전량 주입 | 중복, 오래된 최근 사건의 영구화, 주의 분산 | 같은 파일들 |
| 높음 | dynamic context를 실제 최신 user text 뒤에 붙임 | 짧은 발화보다 Bond/Memory가 마지막 초점이 됨 | `src/openai/messages.ts`, `src/chat/turn-context.ts` |
| 높음 | service-backend가 conversation 전체를 보내며 offset을 항상 `0`으로 설정 | raw history와 Summary가 중복되고 prompt가 계속 증가 | `opod-service-backend/.../message-reply.worker.ts`, `message-reply.provider.ts` |
| 높음 | retrieval query가 최신 user text 하나뿐 | `그건 왜?`, 주제 복귀, 대명사 후속 발화에서 회수 실패 | `src/chat/chat-service.ts` |
| 높음 | min-max 정규화 후 absolute relevance floor 없이 top-K 반환 | 관련 기억이 없어도 가장 덜 무관한 기억을 강제 회수 | `src/memory/retrieval.ts` |
| 중간 | 최근 접근 512개만 후보로 읽고, 조회된 top-K를 모두 touch | 자주 뽑힌 기억이 더 자주 후보가 되는 순환, 오래된 중요 기억 starvation | `src/memory/postgres-memory-store.ts` |
| 높음 | Observation/Reflection record에 source speaker, confidence, validity, status, sensitivity/consent가 없음 | 추론을 사실처럼 사용, 정정·망각·만료를 감사하기 어려움 | `src/memory/types.ts` 및 schema owner |
| 중간 | Summary와 Core가 재작성된 opaque text | 어느 사실이 왜 바뀌었는지 추적하기 어려움 | `src/memory/consolidation.ts`, `src/memory/reflection.ts` |
| 중간 | Reflection을 고정된 높은 importance로 저장하고 confidence를 기록하지 않음 | 고수준 추론이 원관찰보다 강하게 회수될 수 있음 | `src/memory/reflection.ts` |
| 높음 | 자기 일상 공유는 Bond L3, 반말은 L4에서 허용 | 초기 대화가 심문처럼 되고 한국어 말투 전환이 기계적 | `src/chat/turn-context.ts` |
| 높음 | “자기 하루 중”이라고 지시하지만 현재 활동 정본이 없음 | `뭐 해?`에 서로 모순되는 근황을 발명 | `src/chat/system-prompt.ts`, 현재 도구 목록 |
| 중간 | production 설정은 endpoint/key/model 중심이고 generation parameter snapshot이 없음 | 모델·sampling 변화와 Persona 변화의 효과를 분리하기 어려움 | `src/provider/db-settings-provider.ts`, 호출 계약 |
| 중간 | service-backend가 완성된 non-streaming 답을 기다림 | 첫 반응까지의 침묵이 길어져 사람 같은 리듬 저하 | `message-reply.provider.ts` |

### 10.3 기존 평가의 장점과 빈칸

[`long-conversation-eval.md`](long-conversation-eval.md)의 H30에는 low-energy mutuality,
correction, compaction, emotional arc, persona pressure, interruption, ambiguity가 이미 있다.
`evals/evaluate.ts`에도 질문 종결 비율·최장 질문 streak·near duplicate·길이·형식 검사가 있고,
`evals/target.ts`와 ATIF에는 latency와 token usage가 있다. 따라서 P0에서 같은 분석기를 새로
만들면 안 된다.

남은 빈칸은 다음이다.

- 평가 fixture의 Persona/canon이 아니라 **실제로 target이 조립한 prompt의 fingerprint**
- response 길이·질문·반복·latency/token의 suite-level 분포
- 모든 대상 캐릭터에 동일하게 적용하는 첫 대화 상호성, 말투 전환, 짧은 후속 발화,
  World State 일관성 probe
- 자연스러움 실패를 context/persona/memory/model/UX 소유자로 나누는 taxonomy
- blind human pairwise workflow와 gold transcript calibration artifact
- production transcript 사용 시 동의·비식별화·보존 기간에 대한 승인 경계

### 10.4 개발 DB 전체 캐릭터 교차 확인

2026-09-02에 개발 서버 DB를 `READ ONLY` transaction으로 확인했다. 사용자 관계 메모리는
제외하고 캐릭터 소유 Persona와 character memory만 집계했다.

| 캐릭터 | Active Persona | Persona 문자 수 | Active character memory | Memory 문자 수 | 실제 chat call |
| --- | ---: | ---: | ---: | ---: | ---: |
| 권도건 | 12 | 5,255 | 25 | 954 | 4 |
| 나희 | 12 | 4,068 | 25 | 1,327 | 0 |
| 서린 | 9 | 3,250 | 16 | 1,014 | 3 |
| 한소이 | 12 | 3,802 | 13 | 1,241 | 6 |

전체 합계는 active Persona 45개, active character memory 79개이며 soft-deleted row는 0개였다.
실제 chat log는 13건뿐이고, 나희는 관찰값이 없다. 권도건의 최신 chat은 현재 Persona 수정 전,
한소이의 최신 chat은 최근 memory 추가 전이라 현재 snapshot의 품질 근거도 불완전하다.

교차 확인에서 드러난 공통 결함은 다음과 같다.

- 네 캐릭터 모두 `content_style`과 `greeting`을 가진다. 로그가 있는 세 캐릭터의 실제 prompt
  13/13에 두 block과 전량 character fact가 함께 들어갔다.
- 핵심 프로필·취향·루틴이 Persona와 character memory에 중복된다. 한소이의 memory는 상대적으로
  episodic하지만 유효 기간이 없는 과거 진행 상태가 남아 있다.
- 79개 memory 중 `auto:` reason은 1개뿐이며 게시물 유래 memory도 서로 다른 reason 형식을 쓴다.
  reason 접두사만으로 provenance를 판별할 수 없다.
- 모든 row가 active라 superseded/expired/ended 상태를 표현할 수 없다.
- 감사 로그는 before/after snapshot을 보관하지 않으며, 한소이의 현재 row 수와 create log 수가
  일치하지 않는다. 과거 Persona/Memory release를 DB만으로 재구성할 수 없다.
- 실제 prompt는 캐릭터별로 서로 다른 모델을 사용했고 generation parameter가 명시적으로 기록되지
  않았다. 현재 로그를 캐릭터 간 품질 순위로 사용하면 안 된다.

따라서 개별 Persona 문구 수정은 공통 원인을 제거하지 못한다. baseline부터 동일 공통 scenario를
실행 시점의 활성 캐릭터 전체에 적용하고, model·sampling·Persona/Memory fingerprint가 다른 결과를
한 평균에 섞지 않아야 한다.

## 11. 단계별 개선 로드맵

### P0 — Baseline과 평가 보정

- 모델·sampling·Persona/canon·memory policy·suite·git snapshot을 식별 가능하게 기록
- H30과 공통 naturalness probe를 식별 가능한 동일 조건에서 반복 실행
- 실패를 context/persona/memory/model/UX로 분류
- 자동 지표를 diagnostic-only로 추가하고 사람 gold set으로 judge를 보정
- 결과물: 재현 가능한 baseline report와 P1 우선순위

### P1 — 답변 경로와 대화 상태

- Persona block channel filtering, compact identity kernel, retrievable lore 분리
- dynamic context와 최신 user text의 순서 A/B
- production history window와 정확한 history offset
- 최근 2~4턴 기반 retrieval query 및 absolute relevance floor
- 초기 상호성을 막지 않는 관계 모델과 별도 Korean register state
- Character World State의 최소 read model
- model/sampling production config version 고정

### P2 — Memory lifecycle

- provenance, confidence, temporal validity, status/supersedes, sensitivity/consent
- create/merge/supersede/forget/expire API와 retrieval filter
- dense+lexical/entity hybrid retrieval, diversity, empty retrieval
- 실제 사용된 기억만 use/touch하고 correction/forget audit 제공

### P3 — Dialogue policy와 UX

- dialogue move 다양성 및 open-loop 관리
- repair와 종료 의사 우선 처리
- 필요 턴만 planner/rewrite하는 selective orchestration
- streaming, typing indicator, bubble 분할, 응답 지연을 사용자 실험으로 분리 평가

### P4 — Fine-tuning

- 사람 선호가 붙은 다중 턴 한국어 자료로 behavior/style만 학습
- base model 대비 prompt-only와 fine-tuned 후보의 blind pairwise A/B
- Persona·사실·기억은 계속 외부 상태로 유지

## 12. 피해야 할 해결책

- 모든 실패 상황의 정답 예시를 production prompt에 추가
- 긴 Persona가 약해서 문제라고 보고 더 긴 Persona를 작성
- character memory를 최근 N개로만 잘라 핵심 canon까지 잃음
- relevance threshold 없이 top-K를 “기억 능력”으로 간주
- 관계 XP가 오르기 전까지 평범한 자기 노출과 상호성을 금지
- 매 턴 planner와 writer를 별도 대형 모델로 호출
- context·memory 결함을 남긴 채 fine-tuning으로 덮음
- 자동 judge 점수를 사람 보정 없이 release 사실로 표현
- 사용자 동의 없이 production transcript 원문을 gold set으로 저장소에 반입

## 13. 연구 자료

아래 자료는 2026-09-02에 확인했다. 논문은 설계 원리를 제공하지만 OPOD 제품 결정 자체를
대신하지 않는다. 특히 2026년 preprint는 방향성 근거로만 사용한다.

### Architecture와 Memory

- [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) — memory stream, recency·importance·relevance, reflection과 계획.
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) — 제한된 context와 외부 기억 사이의 계층형 관리.
- [CoALA: Cognitive Architectures for Language Agents](https://arxiv.org/abs/2309.02427) — memory, action, decision process를 분리해 보는 agent architecture.
- [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813) — 정보 추출뿐 아니라 다중 세션, 시간, 갱신, abstention을 포함한 장기 기억 평가.
- [LoCoMo: Evaluating Very Long-Term Conversational Memory of LLM Agents](https://arxiv.org/abs/2402.17753) — 장기 다중 세션 대화의 기억·추론 평가.
- [Beyond Goldfish Memory: Long-Term Open-Domain Conversation](https://aclanthology.org/2022.acl-long.356/) — 장기 open-domain 대화에서 과거 발화 선택과 생성.
- [THEANINE: A Framework for Long-Term Dialogue](https://aclanthology.org/2025.naacl-long.435/) — 장기 대화에서 기억과 응답 생성을 함께 다루는 최근 연구.
- [MemOps](https://arxiv.org/abs/2607.12893) — 생성·갱신·삭제·감사 가능한 운영 메모리를 강조하는 2026년 7월 preprint; 성숙한 표준으로 간주하지 않음.

### 대화 품질과 평가

- [Towards a Human-like Open-Domain Chatbot — Meena](https://arxiv.org/abs/2001.09977) — sensibleness와 specificity를 함께 보는 SSA.
- [Recipes for Building an Open-Domain Chatbot — BlenderBot](https://arxiv.org/abs/2004.13637) — engagingness, knowledge, empathy, Persona 능력의 결합.
- [What Makes a Good Conversation?](https://arxiv.org/abs/1902.08654) — 대화 품질을 참여자 간 상호작용 특성으로 분석.
- [ACUTE-Eval](https://arxiv.org/abs/1909.03087) — 전체 대화를 가린 pairwise 비교로 dialogue system을 평가.
- [PersonaChat](https://ai.meta.com/research/publications/personalizing-dialogue-agents-i-have-a-dog-do-you-have-pets-too/) — Persona 기반 대화 데이터와 일관성 연구의 대표 출발점.
- [CharacterEval](https://aclanthology.org/2024.acl-long.638.pdf) — role-playing character의 knowledge, behavior, style을 세분화해 평가.
- [RMTBench](https://aclanthology.org/2025.findings-emnlp.730.pdf) — role-playing model의 다중 턴 능력 평가.
- [EmoCharacter](https://aclanthology.org/2025.naacl-long.316/) — 캐릭터 역할 수행에서 감정 이해와 일관성을 평가.

### 한국어와 제품 UX

- [ETRI 한국어 페르소나 대화 연구](https://ksp.etri.re.kr/ksp/article/read?id=65808) — 한국어 Persona 대화 데이터·모델 연구.
- [Korean Speech Level Shift and Interaction](https://benjamins.com/catalog/kl.20010.kim) — 한국어 높임말 전환이 상호작용과 관계 협상이라는 근거.
- [Dynamic Response Delays in Chatbots](https://aisel.aisnet.org/ecis2018_rp/113/) — 응답 지연이 사용자 경험과 사회적 지각에 미치는 영향을 다룬 연구.

### 모델 선택과 운영

- [OpenAI model selection guidance](https://developers.openai.com/api/docs/guides/latest-model) — 최신 모델 선택은 고정된 명성보다 실제 task eval을 기준으로 해야 한다는 공식 가이드. OPOD에서도 후보 모델을 동일 Persona/Memory snapshot과 사람 보정 eval로 비교해야 한다.
