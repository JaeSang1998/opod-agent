# 캐릭터 챗 자연스러움 개선 — 다음 세션 인계

- 인계일: 2026-09-07
- 작업 브랜치: `codex/character-chat-p1-persona-router`
- 범위: 캐릭터 공통 Persona·Memory·평가 구조
- 현재 단계: P1-1 구조 구현 완료, 실제 캐릭터 모델 A/B 대기

## 다음 세션이 먼저 알아야 할 결론

이번 작업은 권도건이나 특정 캐릭터의 말투 패치가 아니다. 모든 캐릭터가 공유하는 prompt/context
경로를 개선하는 작업이다. 캐릭터 이름, 직업, 취미, 대표 소재나 특정 문장을 runtime 분기 조건으로
추가하면 안 된다.

자동 평가는 최종 품질 판정자가 아니다. 과거 judge가 사용자가 `뜬금없음`, `어색함`, `FAILURE`로
판정한 문장을 PASS 처리했기 때문에, 대화 자연스러움의 최종 판정은 사용자가 원문 transcript를 보고
내린다. 구조 preflight 성공을 대화 품질 PASS로 승격하지 않는다.

현재 코드가 증명한 것은 Persona source의 prompt 배치뿐이다. 실제 모델의 자연스러운 한국어,
캐릭터성 유지, 뜬금없는 자기소개·직업·게시물 소재 감소는 아직 증명하지 않았다.

## 사용자 검수에서 확정된 실패 기준

- 사용자가 꺼내지 않은 날씨, 위치, 방문 목적, 직업, 촬영, 게시물을 먼저 화제로 삼지 않는다.
- Persona·Memory는 반응 방식과 의견을 형성하는 배경이지, 매 턴 보여줘야 하는 체크리스트가 아니다.
- 상품 설명, 게시물 캡션, 상담원 응대, 업무 jargon처럼 들리는 문장을 피한다.
- 직전 발화와 연결되지 않은 질문·자기 노출·주제 전환은 실패다.
- 특정 대표 소재를 계속 반복해 캐릭터성을 증명하려 하지 않는다.
- 반말과 존댓말 혼용은 자동 실패가 아니다. Persona와 관계에 맞으면 허용한다.
- 문법적으로 유창하다는 이유만으로 자연스럽다고 판정하지 않는다.

상세 사용자 코멘트와 판정 보존 위치:

- [`character-chat-p0-human-review-2026-09-02.md`](character-chat-p0-human-review-2026-09-02.md)
- [`character-chat-p0-user-review-policy-2026-09-03.md`](character-chat-p0-user-review-policy-2026-09-03.md)
- [`naturalness-human-review-guide.md`](../evals/naturalness-human-review-guide.md)

## 완료된 작업

### 조사와 P0 평가 기반

- 캐릭터 챗 architecture, Persona/Memory 관리, 자연스러운 대화 설계 원칙을 조사했다.
- 사용자 지적을 공통 자연스러움 rubric과 shared prompt 원칙으로 옮겼다.
- 모든 runtime character를 같은 scenario에 교차 실행하는 diagnostic suite를 만들었다.
- 자동 PASS와 사용자 판정을 분리하고, blind review용 artifact 경로를 만들었다.
- 모델·prompt hash·context source provenance 누락이 품질 결과로 통과하지 못하게 했다.

관련 문서:

- [`character-chat-architecture-research-2026-09-02.md`](../character-chat-architecture-research-2026-09-02.md)
- [`character-chat-products-persona-memory-research-2026-09-03.md`](../character-chat-products-persona-memory-research-2026-09-03.md)
- [`character-chat-p0-baseline-plan-2026-09-02.md`](../character-chat-p0-baseline-plan-2026-09-02.md)
- [`character-chat-p0-before-after-2026-09-03.md`](character-chat-p0-before-after-2026-09-03.md)

### P1-0 — Memory fixture와 provenance

- 실제 in-process `MemoryStore`에 lifecycle fixture를 seed하고 retrieval·injection provenance를
  기록하는 구조 probe를 만들었다.
- 현행 unfiltered top-K가 `superseded`, `forgotten`, `stale` record를 주입하는 기준선 실패를
  숨기지 않았다.
- 구조 preflight와 품질 PASS를 분리했다.

상세 결과:

- [`character-chat-p1-0-memory-fixture-provenance-2026-09-07.md`](character-chat-p1-0-memory-fixture-provenance-2026-09-07.md)

### P1-1 — 공용 Persona Router

- Persona block read model에 stable block ID, `kind`, `injection`을 추가했다.
- `RoutedPersonaStore`가 제목이 아니라 stable block ID로 strict manifest를 결합한다.
- `routePersona`가 네 prompt 경로를 단독 소유한다.
  - `always`: stable system prompt
  - `start_only`: 첫 assistant 응답의 tail context
  - `retrieved`: relevance selector가 고른 현재 턴의 tail context
  - `never_prompt`: 미주입
- 누락되거나 중복된 explicit mapping은 실패한다. 매핑 없는 production Store는 기존 동작을 유지한다.
- selector에는 캐릭터 ID, 현재 query, `retrieved` 후보만 전달한다. `never_prompt` 원문은 selector에도
  전달하지 않는다.
- 동적 Persona가 바뀌어도 stable prompt hash는 유지된다.
- debug provenance는 source ID와 route metadata만 포함하고 title/content는 포함하지 않는다.

동일 3턴을 사용한 합성 Persona 2개의 구조 A/B 결과:

| 관측 | Legacy | Routed |
| --- | ---: | ---: |
| 중립 첫 턴의 불필요 source | 4 | 0 |
| 첫 턴 이후 `start_only` 잔류 | 4 | 0 |
| `never_prompt` 누출 | 6 | 0 |
| 관련 질문의 lore 주입 | 해당 없음 | 2/2 |

이 결과의 `qualityPassed`, `passed`, `certificationEligible`은 의도적으로 모두 `false`다.

상세 결과와 결정:

- [`character-chat-p1-1-persona-router-2026-09-07.md`](character-chat-p1-1-persona-router-2026-09-07.md)
- [`0008-explicit-persona-routing.md`](../adr/0008-explicit-persona-routing.md)
- [`persona-memory-plan.md`](../persona-memory-plan.md)

## 현재 데이터 상태와 차단점

- 실행 중인 로컬 Postgres의 `opod.characters`, `opod.character_personas`,
  `opod.character_memories`는 모두 0행이다.
- 이전 읽기 전용 snapshot 증거에는 활성 캐릭터 4명, Persona block 45개, character memory 79개가
  있었다.
- 현재 저장소와 로컬 workspace에는 복구 가능한 개발 DB dump나 개발 DB 연결 `.env`가 없다.
- 따라서 네 실제 캐릭터의 block ID별 routing manifest와 실제 모델 A/B는 아직 만들 수 없다.
- production DB schema, Persona row, DDL은 변경하지 않았다.
- character canon memory는 여전히 전량 stable prompt에 들어간다. P1-1은 이 문제를 해결하지 않는다.

## 다음 실행 순서

1. 개발 DB snapshot을 로컬 격리 DB에 복구한다. 운영 DB를 평가 target으로 직접 사용하지 않는다.
2. 활성 캐릭터 수와 Persona/Memory row count를 읽기 전용으로 확인하고 snapshot 시각을 기록한다.
3. git 밖의 manifest에서 모든 활성 Persona block ID를 `kind/injection`으로 분류한다.
4. 매핑 누락·중복 0과 `never_prompt` selector 노출 0을 preflight로 확인한다.
5. 네 캐릭터 모두에 같은 문맥을 넣어 Legacy/Routed 실제 모델 A/B transcript를 생성한다.
6. 웹 artifact에서 조건 이름을 가리고 원문을 나란히 보여준다. 자동 PASS는 표시하지 않는다.
7. 사용자가 뜬금없는 소재 감소와 캐릭터성 유지 여부를 직접 판정한다.
8. 승인된 효과가 있을 때만 schema owner인 `opod-service-backend`에 typed field DDL을 별도 제안한다.
9. Persona 효과를 고정한 뒤 P1-2 Memory Retrieval Gate를 별도 실험한다. 두 구조를 한 번에 바꿔
   원인을 섞지 않는다.

## 재현과 검증 명령

```bash
npm run eval:persona-router
npm test
npm run test:eval
npm run typecheck
npm run typecheck:eval
npm run lint
npm run build
npm run dead-code
```

마지막 전체 검증 결과:

- 제품 테스트: 280 통과, Postgres 통합 테스트 14 skip
- 평가 테스트: 55 통과, global statement/line coverage 85.09%
- runtime/eval typecheck: 통과
- Biome lint 139개 파일: 통과
- `knip` dead-code 검사: 통과
- production build: 통과
- web typecheck: 통과
- web 테스트: 37 통과
- web production build: 통과. Turbopack의 로컬 port bind 때문에 샌드박스 밖에서 재실행했다.
- `git diff --check`: 통과
- 새 runtime·fixture에서 운영 캐릭터 이름·ID 검색: 0건

`npm run check`는 runtime/eval 단계까지 통과한 뒤 기존 `origin/main`에도 포함된
`web/backend/characters.ts`의 0% coverage 때문에 web global statement/line coverage가
`88.14%`로 계산되어 기준 `90%`에서 중단된다. 해당 production 파일과 coverage 설정은 이번 diff가
아니다. 무관한 범위를 넓히지 않았고, 동일 웹 테스트를 coverage gate 없이 실행한 결과 37개가 모두
통과했으며 web production build도 별도로 통과했다.

`evals/results/`는 gitignore 대상이다. 구조 HTML·JSON이 없는 checkout에서는
`npm run eval:persona-router`로 다시 생성한다. 현재 workspace의 검수 주소는 서버가 살아 있는 동안
`http://127.0.0.1:18181/persona-router-report.html`이다.

## 핵심 코드 진입점

- `src/persona/persona-router.ts`: prompt channel projection과 provenance
- `src/persona/routed-persona-store.ts`: stable block ID 기반 strict mapping
- `src/chat/chat-service.ts`: first-turn 판정, stable/dynamic 조립, selector seam
- `src/chat/turn-context.ts`: first-contact/retrieved Persona tail section
- `evals/persona-router-eval.ts`: 합성 구조 A/B와 false-PASS 방지
- `evals/evaluate.ts`: 실제 대화 diagnostic/H30 집계
- `evals/review.ts`: 사용자 review artifact와 집계

## 지켜야 할 경계

- 특정 캐릭터를 위한 runtime 예외를 만들지 않는다.
- block title 문자열을 영구 routing 계약으로 사용하지 않는다.
- 모델 temperature 조정을 Persona/Memory 구조 개선의 대체물로 취급하지 않는다.
- 실제 답변을 생성하지 않은 구조 test에 자연스러움 PASS를 붙이지 않는다.
- 사용자 검수 이전에 DDL이나 production routing을 활성화하지 않는다.
- 실제 Persona 원문, DB 접속 정보, full prompt가 들어간 runtime manifest를 commit하지 않는다.

## Knowledge Delta

- `user-confirmed`: 캐릭터 챗 개선은 특정 캐릭터가 아니라 공통 runtime 경로가 소유한다.
- `user-confirmed`: 자연스러움의 최종 판정은 자동 judge가 아니라 사용자 transcript review다.
- `repo-evidenced`: Persona Router와 strict ID mapping이 stable/dynamic/excluded 경로를 소유한다.
- `repo-evidenced`: P1-0 기준선은 memory lifecycle filtering이 필요함을 보여준다.
- `repo-evidenced`: 실제 캐릭터 P1-1 A/B는 데이터 snapshot 부재로 아직 실행되지 않았다.
