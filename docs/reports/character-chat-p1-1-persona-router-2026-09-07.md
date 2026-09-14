# 캐릭터 챗 P1-1 — 공용 Persona Router 구조 A/B 결과

- 작성일: 2026-09-07
- 범위: 모든 캐릭터가 공유하는 Persona read model, prompt routing, provenance
- 구조 상태: **검증 통과**
- 실제 캐릭터 적용: **미적용**
- 대화 자연스러움 판정: **하지 않음**

## 결론

기존 경로는 블록의 용도를 표현하지 못해 identity, 첫 만남 정보, 취미·직업 같은 배경, 게시물 제작
메모를 모두 stable system prompt에 넣었다. P1-1은 블록 ID에 명시적 `kind + injection`을 붙이는
DDL-free read adapter와 공용 Persona Router를 구현했다.

Router는 `always`만 system prompt에 남기고, `start_only`와 선택된 `retrieved`는 필요한 턴의 tail
context로 보낸다. `never_prompt`는 제외한다. 제목 문자열, 캐릭터 이름·ID, 직업, 취미, 대표 소재에
따른 runtime 분기는 없다.

두 합성 Persona에 동일한 세 문장을 넣은 구조 A/B에서 Candidate는 중립 첫 턴의 무관 lore·제작
메모, 첫 턴 이후 intro, 모든 턴의 creator note를 제거했다. 사용자가 취미를 직접 물은 턴에는 각
Persona의 lore가 정상적으로 들어갔다. 모든 턴에서 stable prompt hash도 Persona별로 하나로
유지됐다.

이 결과는 **무슨 source가 prompt에 들어가는지**만 증명한다. 실제 모델 답변을 만들지 않았으므로
자연스러운 한국어, 캐릭터성, 뜬금없는 소재의 실제 발화 감소는 아직 증명하지 않았다.

## 구조 계약

| 정책 | prompt 위치 | 조건 |
| --- | --- | --- |
| `always` | stable system prompt | identity, 핵심 behavior·voice |
| `start_only` | turn context | history offset 0이고 이전 assistant 발화가 없는 첫 응답 |
| `retrieved` | turn context | 별도 relevance owner가 현재 턴에 선택한 경우 |
| `never_prompt` | 미주입 | 콘텐츠 제작·운영 metadata |

`retrieved`의 실제 검색 품질은 P1-1 범위가 아니다. selector 경계에는 캐릭터 ID, 현재 질의,
`retrieved`로 이미 분류된 후보만 전달하며 `never_prompt` 원문은 전달하지 않는다. 이번 fixture는
배관 검증을 위해 명시한 단순 문자열 rule만 사용한다. 운영용 query, threshold, index는 후속
단계에서 검증한다.

## 동일 문맥 구조 A/B

두 합성 인물 모두 다음 문맥을 그대로 사용했다.

1. `안녕`
2. `요즘 취미 얘기해줘`
3. `그 얘기는 됐고 오늘 점심 뭐 먹을까`

| 관측 | Legacy Control | Routed Candidate |
| --- | ---: | ---: |
| 중립 첫 턴에 주입된 `retrieved/never_prompt` source | 4 | 0 |
| 첫 턴 이후 남은 `start_only` source | 4 | 0 |
| 전 구간 `never_prompt` 누출 | 6 | 0 |
| 관련 질문에서 lore의 `turn_context` 주입 | 해당 없음 | 2/2 |
| Persona별 stable prompt hash 개수 | 1 | 1 |

구조 preflight는 fixture 기대 destination, 실제 prompt 원문 위치, content-free provenance의 세 값이
모두 같은지 검사했다. provenance에는 block ID, kind, injection, mapping mode, destination, reason만
있고 title/content는 없다.

## 검수 artifact

- [브라우저용 구조 A/B](../../evals/results/persona-router-p1-1-2026-09-07/persona-router-report.html)
- [구조 결과 JSON](../../evals/results/persona-router-p1-1-2026-09-07/persona-router-report.json)
- [재현 fixture](../../evals/cases/p1-persona-router.json)

브라우저 artifact 상단은 `대화 자연스러움: 판정하지 않음`을 명시하고, 아래에서 두 합성 Persona의
block 분류와 turn별 Control/Candidate destination을 나란히 보여준다. 데스크톱과 390px 모바일 폭의
렌더링을 확인했으며 모바일에서는 표만 가로 스크롤된다.

## 코드 변경

| 영역 | 변경 |
| --- | --- |
| Persona read model | optional stable block ID, kind, injection 추가 |
| DDL-free adapter | ID 기반 strict manifest join; 누락·중복 route 거부 |
| Persona Router | stable/start/retrieved/excluded projection의 단일 소유자 |
| ChatService | 첫 응답 판별, selector seam, stable/dynamic 조립, provenance |
| Turn context | first-contact와 relevant-character-background section 추가 |
| HTTP eval parser | Persona provenance 검증 및 원문 제거 |
| Eval artifact | 2 Persona × 동일 3턴 × Control/Candidate JSON·HTML |

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| 제품 테스트 | 280 통과, Postgres 통합 테스트 14 skip |
| 평가 테스트 | 55 통과, global statement/line coverage 85.09% |
| TypeScript | runtime/eval 모두 통과 |
| Biome lint | 139개 파일 통과 |
| dead-code (`knip`) | 통과 |
| production build | 통과 |
| 변경 공백 검사 | `git diff --check` 통과 |
| 범용성 검색 | 새 runtime·fixture에 운영 캐릭터 이름·ID 0건 |

## 운영 적용 경계

현재 `PostgresPersonaStore`는 block ID를 읽지만 DB에는 `kind/injection` field를 추가하지 않았다.
명시적 manifest를 구성하지 않은 Store는 호환성을 위해 기존 동작을 유지한다. 따라서 코드만으로
개발·운영 캐릭터의 실제 prompt가 이미 바뀐 것은 아니다.

또한 현재 실행 중인 로컬 Postgres 복제본을 읽은 결과 `characters`, `character_personas`,
`character_memories`가 모두 0행이었다. 이전 개발 snapshot의 4명·45 Persona block·79 character
memory 근거는 남아 있지만, P1-1 후보를 네 캐릭터에 연결한 실제 모델 A/B는 snapshot을 다시 격리한
후 해야 한다. 저장소 범위에는 복구 가능한 DB dump/snapshot이나 실제 개발 DB 연결 설정도 남아
있지 않았다.

Character canon memory는 이번 단계에서 변경하지 않았다. 전량 stable prompt에 들어가는 현행
동작은 계속되므로 게시물·과거 사건의 과주입이 Persona Router 하나로 모두 해결됐다고 볼 수 없다.

## 다음 단계

1. 개발 DB snapshot을 로컬 격리 DB에 다시 복구하고, git 밖 manifest에서 활성 block 전부를 사람이
   `kind/injection`으로 분류한다.
2. 매핑 누락 0을 preflight로 확인한 뒤 네 캐릭터의 동일 문맥 실제 모델 A/B를 만든다.
3. 답변 원문은 자동 PASS 없이 사용자가 비교한다. 무관 직업·게시물·대표 소재가 실제로 줄고
   캐릭터성은 유지되는지 확인한다.
4. 효과가 승인된 뒤에만 schema owner에 typed field를 제안한다. 그전에는 DDL을 실행하지 않는다.
5. 별도로 P1-2 Memory Retrieval Gate에서 character/user memory의 relevance와 lifecycle을 다룬다.

## Knowledge Delta

- `user-confirmed`: 개선은 특정 캐릭터가 아니라 모든 캐릭터의 공통 경로가 소유한다.
- `repo-evidenced`: `routePersona`가 prompt channel projection의 단일 소유자이고,
  `RoutedPersonaStore`는 title이 아닌 source ID로만 정책을 붙인다.
- `repo-evidenced`: 동적 Persona는 tail context에만 들어가므로 ADR 0007의 stable-prefix 규칙을 지킨다.
- 위 결정은 ADR 0008, ADR 0002/0007 addendum, 본 보고서에 반영했다.
