# S1 — 실제 Persona·캐릭터 Memory source 조사

- 조사일: 2026-09-07
- 상태: 원문 조사와 승인된 혼합 블록의 실험 입력 분리 완료. 전체 mapping·S2 모델 비교는 준비 전
- 범위: 활성 캐릭터 설정 4건, 미삭제 Persona 45건, 캐릭터 Memory 79건
- Snapshot 시각: 2026-09-07 15:22:21 KST
- Source hash: `819922db0f97eb333c896ce8dae48f7d3d953475da8e860a0de39372120fdb0f`
- 원문 처리: 사용자가 로컬 격리·분석을 승인. 개발 DB의 repeatable-read / read-only 트랜잭션으로
  한 시점의 source를 읽고 ROLLBACK. 사용자 대화·사용자 기억·인증 정보·admin 설정은 제외

## 결론

블록 제목마다 하나의 injection을 자동 지정하는 방식으로는 현재 데이터를 충실하게 분류할 수
없다. DM 말투와 게시물 제작 지침, 관계 서사와 상시 유지해야 할 대화 경계가 실제로 섞여 있다.
또한 일부 정적 examples에는 사용자 검수에서 지적된 인사 표현과 근거 없는 현재 활동·공유
기억을 말하는 답변이 포함돼 있다. 이는 source에 해당 표현이 있다는 증거이며, 모델 실패의
단일 원인이라는 판정은 아니다.

원문 조사 뒤 사용자가 승인한 혼합 블록 8개를 실험 입력에서만 분리했다. Persona 원문·DB·제품
runtime은 변경하지 않았고 모델을 호출하지 않았다. 아래 분류 후보 전체를 적용한 것은 아니다.

## 분류 조사 결과

내용을 전부 읽고 block ID 및 content hash에 연결한 실험 후보를 작성했다. 제목은 표시용이다.

| 분류 | 블록 수 | 의미 |
| --- | ---: | --- |
| `always` 후보 | 18 | identity·behavior·voice·대화 경계를 보수적으로 유지 |
| `retrieved` 후보 | 8 | world·취향·목표 세부 |
| `never_prompt` 후보 | 7 | 기존 reactive greeting 제외 4개 + 콘텐츠 제작 지침 3개 |
| 혼합 목적 — 분리 적용 | 8 | 승인된 22개 원문 구간을 실험 입력에만 적용 |
| examples — 미확정 | 4 | 여러 상황·관계·말투와 사실 서술이 한 블록에 있음 |
| 합계 | 45 | 4명 모두 조사. 혼합 블록 외 37개는 기존 동작 유지 |

`always` 후보에는 상세 외형·이력도 남는다. 이는 첫 비교에서 identity 손실을 피하려는 보수적
제안이며, 최소 identity kernel을 완성했다는 뜻이 아니다. `greeting` 4개는 현행 reactive 제외를
유지하는 제안이다. 이를 새로 `start_only`로 바꾸거나 proactive 발송 기능을 추가하지 않는다.

혼합 블록은 다음과 같다. 아래 C1~C4/Bxx 별칭의 원문 ID 대응은 로컬 artifact에만 둔다.

| 별칭 | 표시 제목 | 다른 용도가 함께 있는 부분 |
| --- | --- | --- |
| C1-B05 | voice | DM 말투 / 캡션·해시태그 / 공통 표현 금지 |
| C1-B07 | content_style | 피드·촬영 제작 지침 / 협찬 거절 원칙 |
| C1-B08 | relationships | 인물·관계 서사 / 연애 비공개 경계 |
| C1-B10 | boundaries | DM 경계 / 공개 댓글 응대 지침 |
| C2-B03 | voice | 친밀도별 DM / 게시물 문장 / 공통 표현 규칙 |
| C3-B08 | relationships | 인물·크루 서사 / 책임·사용자 존중·친밀도 경계 |
| C4-B08 | relationships | 협업 서사 / 개인정보·독점 관계 경계 |
| C4-B10 | boundaries | 대화·동의 경계 / 의상·촬영 제작 제한 |

실험용 분리안은 8개 원문을 UTF-8 byte 범위 22개로 나눈다. 모든 구간을 이어 붙이면
원문과 byte 단위로 같다. source ID·원문 hash·구간 hash를 보존한다. DB 행을 쪼개거나 원문을
재작성하지 않고 평가 전용 `projectPersonaSources`로 입력을 만든다. 제품 adapter는 그대로다.

## Memory와 예시의 별도 문제

- Memory의 기존 type은 event 26 / fact 13 / goal 7 / preference 16 / relationship 3 /
  routine 14다. Agent는 `content`만 읽는다. 새 schema보다 기존 metadata 활용을 먼저 검토한다.
- `auto:` reason은 1개지만 다른 reason의 게시 사건도 있다. 이 접두어만으로 게시물 출처나
  사건을 분류하지 않는다. `event`도 과거 정체성 서사와 최근 근황을 함께 포함하므로 type만으로
  현재성·유효성·주입 정책을 정하지 않는다.
- 79개 중 63개에 Persona와 주제 또는 일부 사실이 겹치는 후보를 주석으로 연결했다. 단순한
  주제 공유도 포함한 탐색 목록이므로 63개를 완전 중복·삭제 가능 항목으로 해석하지 않는다.
  의미적 중복 제거는 수행하지 않았다.
- 정적 examples 4개는 말투 학습용 예시와 사건·현재 활동을 주장하는 답변이 혼합돼 있다.
  기존 실패 표현의 재등장, 입력에 없는 공유 기억, 답장 지연 사유 설명을 로컬 근거에 기록했다.
  `start_only`로 옮겨도 첫 응답에서 이 내용을 모델에 주는 문제는 남는다.
- Persona에서 제외한 사실이 character canon 또는 examples에 남으면 경로 하나를 바꾼
  효과가 약해질 수 있다. 그러나 이 가능성만으로 전체 canon·examples를 제거하지 않는다.

## 다음 결정과 실험 경계

혼합 목적 8개를 DB 원문 변경 없이 실험 입력에서만 범위별로 투영하는 결정은 사용자 승인 후
구현·검증했다. 22개 구간 중 대화 말투·행동 경계 11개는 `always`, 제작 지침 8개는
`never_prompt`, 관계 서사 3개는 `retrieved`다. 나머지 37개는 legacy 정책을 유지한다.

examples 4개의 보존·선택·제외와 실제 selector 방식은 각각 별도 결정이다. 원문 분리 승인으로
예시 삭제·문장 재작성·모델 호출·DDL이 함께 승인된 것으로 처리하지 않는다. 같은 대화에서
source 분리와 examples 변경을 동시에 도입해 효과를 섞지 않는다.

후속 진행 요청으로 [examples 54문답 검토와 A/B/C 입력](character-chat-s1-examples-review-2026-09-07.md)을
준비했다. C는 기존 분리 입력에서 예시 네 ID만 미주입하는 로컬 후보다. 제품 정책은 유지하며,
분리 효과와 예시 효과는 A↔B / B↔C로 각각 비교한다. 기존 source·승인된 분리 입력은 그대로다.

## 로컬 artifact와 검증

다음 파일은 `evals/results/` 아래 gitignore 대상이며 이 checkout에만 존재한다.

- [원문 snapshot](../../evals/results/s1-source-audit-2026-09-07/source-snapshot.json)
- [45개 Persona·79개 Memory 조사표](../../evals/results/s1-source-audit-2026-09-07/source-audit.md)
- [조사 데이터](../../evals/results/s1-source-audit-2026-09-07/source-audit.json)
- [혼합 8개 분리 검토안](../../evals/results/s1-source-audit-2026-09-07/mixed-block-proposal.md)
- [원문 범위 데이터](../../evals/results/s1-source-audit-2026-09-07/mixed-block-proposal.json)
- [원문 그대로의 비교 입력](../../evals/results/s1-source-audit-2026-09-07/control-personas.json)
- [승인된 구간 계획](../../evals/results/s1-source-audit-2026-09-07/source-projection.json)
- [분리된 실험 입력](../../evals/results/s1-source-audit-2026-09-07/applied-mixed-blocks-final/projected-personas.json)
- [원문 없는 출처·배치 보고서](../../evals/results/s1-source-audit-2026-09-07/applied-mixed-blocks-final/projection-report.json)
- [독립 원문 보존 검증](../../evals/results/s1-source-audit-2026-09-07/applied-mixed-blocks-final/integrity-check.json)

Snapshot hash 재계산, source ID 유일성·관계 참조, 45/79 전수 조사 연결, 원문 불변성,
8개/22구간 원문 재조립, ignore·파일 권한을 확인했다. source 디렉터리 0700, 파일 0600이다.
최초 `mixed-block-proposal.*`은 승인 전 조사 기록으로 보존한다. 적용한 구간 계획은
`source-projection.json`이며 전체 Persona의 strict runtime manifest와는 구분한다.

### 실험 입력 분리 검증

- `evals/persona-source-projection.ts`는 원문 hash, 연속·전체 범위, UTF-8 경계, ID 중복·충돌을
  검사한다. 원문이 변경되거나 일부만 지정되면 실행을 중단한다. 출력은 새 디렉터리에만 쓴다.
- 4명·45개 원본 블록에서 8개만 22개로 대체해 59개를 생성했다. 나머지 37개, examples 4개,
  canon Memory 79개, 캐릭터 기본 정보와 순서를 보존했다. 기존 greeting 제외도 유지했다.
- 4명 × 3조건의 실제 source 배치 12건을 검사했다. 상세 서사 미선택/전체 선택 사이에 stable
  prompt hash가 동일하고, `always`/`never_prompt`/`retrieved` 목적지가 각각 맞았다.
- 합성 입력은 기존 `ChatService.prepare`를 통해 추가 검증했다. 제작 지침이 selector·prompt에
  전달되지 않고, 선택한 lore만 tail context에 들어가며 chat/embedding 호출이 0회임을 확인했다.
- `npm run test:eval:coverage`: 65개 통과, 기존 평가 coverage gate 통과.
- `npm run test:coverage`: 280개 통과, Postgres 통합 14개 skip, runtime coverage gate 통과.
- `npm run typecheck`, `npm run typecheck:eval`, `npm run lint`, `npm run build`: 통과.
- 전체 `npm run dead-code`는 미설치 웹 의존성 때문에 Next binary와 React DOM 항목에서 실패했다.
  변경 범위의 `npm run dead-code -- --workspace .`는 통과했다. 웹 코드는 변경하지 않았으며
  웹 테스트·빌드는 이번 분리 작업에서 재실행하지 않았다.

재현 시 `EVAL_RESULTS_DIR`에는 존재하지 않는 디렉터리를 지정한다.

```bash
EVAL_PERSONA_INPUT=evals/results/s1-source-audit-2026-09-07/control-personas.json \
EVAL_PERSONA_PROJECTION=evals/results/s1-source-audit-2026-09-07/source-projection.json \
npm run eval:persona-projection
```

이 결과는 배치와 원문 보존 검증이다. `qualityPassed`, `certificationEligible`,
`fullPersonaRoutingReady`는 모두 `false`이며 실제 selector나 모델 응답 품질을 검증하지 않았다.

## Knowledge Delta

- `repo-evidenced`: 실제 source에 용도가 다른 문장이 한 block으로 묶여 있다.
- `repo-evidenced`: DB의 기존 Memory type이 Agent read model에서 소실된다.
- `repo-evidenced`: 일부 기존 실패 표현·무근거 상태 서술이 정적 examples에 존재한다.
- `user-confirmed`: 혼합 8개/22구간의 실험 입력 분리만 승인됐으며 examples는 유지한다.
- `owner-found`: 주입 정책은 기존 `routePersona`가 계속 소유한다. Store·ChatService를 복제하지 않는다.
- `owner-absent`: 원문 byte 범위의 무손실 분리 기능은 기존 평가 경로에 없어 평가 전용 함수로 추가했다.
  사용법과 소유권은 기존 `evals/README.md`에 기록했다. 별도 codebase guide는 만들지 않았다.
- 조사 후보 전체나 이번 분리 결과를 확정 제품 정책·품질 개선 증거로 승격하지 않는다.
