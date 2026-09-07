# 캐릭터 챗 자연스러움 개선 — 다음 세션 인계

- 인계일: 2026-09-07
- 작업 브랜치: `codex/character-chat-p1-persona-router`
- 범위: 캐릭터 공통 Persona·Memory·평가 구조
- 현재 단계: S1 조사·A/B/C 입력·모델 경로 구현과 승인된 실제 모델 smoke 12회 완료. 청구 $0.020053869, 사용자 검수·반복 본 비교 대기. 제품 정책·개선 효과 미확정
- 현재 계획: [구조 실험 계약과 실행 순서](../character-chat-products-persona-memory-research-2026-09-03.md#10-실험-계약--품질과-원인을-함께-확인한다-2026-09-07-수정), 같은 문서 11절

## 다음 세션이 먼저 알아야 할 결론

이번 작업은 권도건이나 특정 캐릭터의 말투 패치가 아니다. 모든 캐릭터가 공유하는 prompt/context
경로를 개선하는 작업이다. 캐릭터 이름, 직업, 취미, 대표 소재나 특정 문장을 runtime 분기 조건으로
추가하면 안 된다.

자동 평가는 최종 품질 판정자가 아니다. 과거 judge가 사용자가 `뜬금없음`, `어색함`, `FAILURE`로
판정한 문장을 PASS 처리했기 때문에, 대화 자연스러움의 최종 판정은 사용자가 원문 transcript를 보고
내린다. 구조 preflight 성공을 대화 품질 PASS로 승격하지 않는다.

현재 검증한 것은 Persona source 배치와 실제 모델 12회의 요청/응답 연결이다. 실제 모델의 자연스러운 한국어,
캐릭터성 유지, 뜬금없는 자기소개·직업·게시물 소재 감소는 아직 증명하지 않았다.

2026-09-07 재검토에서 전량 주입을 유일한 원인으로 단정한 표현을 수정했다. character canon은
Router 밖에서 여전히 전량 주입되고, 실제 selector도 기본 제공되지 않는다. manifest만 만들면
실제 Routed A/B가 준비된 것으로 간주하지 않는다. 관련 source 선택을 사전에 사람이 대신하는
진단과 자동 선택 경로의 성능을 구분하며, 전자의 개선만으로 서비스 적용을 결정하지 않는다.

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

- 최초 인계 당시 로컬 Postgres 세 테이블은 0행이었다. 이 기록은 개발 DB가 비었다는 뜻이 아니다.
- 2026-09-07 14:49 KST 개발 DB에 접속해 `BEGIN READ ONLY`와 `transaction_read_only=on`으로
  조회했다. 전체 행 수는 `characters=4`, `character_personas=45`, `character_memories=79`였다.
  트랜잭션은 ROLLBACK으로 끝났고 데이터·schema는 변경하지 않았다.
- 이 count에는 활성/삭제 조건을 적용하지 않았다. 이전 snapshot의 활성 행 수와 같다는 사실만으로
  활성 수·원문·version이 동일하다고 주장하지 않는다. 해당 조건과 hash는 snapshot 준비 시 확인한다.
- 접속 불가는 해소됐다. 14:49 확인 이후의 격리 snapshot과 원문 조사 진행은 아래 S1 결과를 따른다.
  실제 selector 연결·반복 본 비교는 미실행이며 첫 모델 smoke는 아래 후속 결과를 따른다.
  접속 정보·인증 파일 내용은 문서나 artifact에 기록하지 않는다.
- character canon memory는 여전히 전량 stable prompt에 들어간다. P1-1은 이 문제를 해결하지 않는다.

### 후속 S1 읽기 전용 집계 (2026-09-07)

후속 진행 요청에 따라 `status=active`, `deleted_at IS NULL`을 적용해 확인했다. 활성 캐릭터
4명·Persona 45개·character memory 79개이며 삭제된 Persona/Memory는 0개다. 원문을 조회
결과로 내보내지 않고 집계만 수행했다.

| 항목 | 결과 |
| --- | ---: |
| Persona 원문 총 문자 수 / 최대 블록 | 16,375 / 1,405 |
| Memory 원문 총 문자 수 / 최대 항목 | 4,536 / 356 |
| legacy greeting 제외 / 나머지 Persona | 4 / 41 |
| 빈 Persona | 0 |
| Memory event / fact / goal | 26 / 13 / 7 |
| Memory preference / relationship / routine | 16 / 3 / 14 |
| `auto:` reason | event 중 1개 |

개발 DB의 기존 `type`은 현재 Agent adapter가 읽지 않는다. 기존 metadata 활용 가능성을
원문 조사에서 먼저 확인하며, type만으로 의미·유효기간·현재 상태를 판단하지 않는다.

원문을 gitignore 대상 `evals/results/s1-source-audit-2026-09-07/source-snapshot.json`으로
격리하는 작업은 자동 승인 검토가 민감한 내부 원문의 로컬 저장에 명시적 승인이 필요하다는
이유로 처음에는 거부했다. 이후 사용자가 해당 저장·분석을 명시적으로 승인했고, 15:22:21 KST에
read-only / repeatable-read snapshot을 생성했다. 개발 DB 쓰기와 실제 사용자 데이터 반입은 없다.

### S1 원문 조사 완료

[S1 보고서](character-chat-s1-source-audit-2026-09-07.md)에 결과를 기록했다. 원문과 ID별 조사표는
위 ignored 디렉터리에만 있다. Persona 45개·Memory 79개 모두 원문을 검토했다.

- `always` 18 / `retrieved` 8 / `never_prompt` 7개 후보와 미확정 12개를 구분했다.
- 조사 당시 미확정은 혼합 목적 8개, examples 4개였다. 이후 혼합 8개 분리는 승인·구현했고,
  examples 4개와 전체 strict manifest는 아직 준비 전이다. 조사 완료를 전체 routing 준비 완료와 혼동하지 않는다.
- 승인된 8개/22구간을 `eval:persona-projection`으로 실험 입력에 적용했다. 원본 45개에서 59개로
  바뀌며 구간 정책은 `always` 11 / `never_prompt` 8 / `retrieved` 3이다. 다른 37개·examples 4개·
  canon 79개는 그대로다. 원문 재작성·DB 분할·제품 runtime 변경은 없다.
- 최종 artifact는 ignored 경로 `evals/results/s1-source-audit-2026-09-07/applied-mixed-blocks-final/`에
  있다. source 원문 복원과 4명 × 3조건의 배치·stable hash 검증을 통과했다. 품질 PASS는 아니다.
- 정적 examples에 과거 실패 인사와 무근거 현재 활동·공유 기억 답변이 존재함을 확인했다.
  examples 처리와 혼합 블록 분리를 같은 변경으로 묶지 않는다.

### Examples 후속 검토와 비교 입력 준비

- [후속 보고서](character-chat-s1-examples-review-2026-09-07.md)에 4개 블록·54문답의 검토를 정리했다.
  일부 표현은 voice/boundaries에도 남아 있어 예시만 제외하면 해결된다고 단정하지 않는다.
- A 원문 45개, B 승인된 혼합 분리 59개, C B와 동일하되 네 예시 source만 `never_prompt`인
  입력을 준비했다. C도 예시 내용을 보존하며 다른 55개 블록과 canon 79개는 그대로다.
- `candidate-without-examples.json`, `examples-comparison-cases.json`, `examples-ablation-preflight.json`은
  기존 ignored source 디렉터리에 있다. C는 검토용 후보이며 제품에 적용한 정책이 아니다.
- 기존 `ChatService.prepare`로 4명 × 8상황 × 3조건 96건을 검증했다. 고정 시각, Bond 미추적,
  tools·사용자 Memory fixture 없음, optional 선택 0의 진단이다. 모델·embedding 호출은 0회다.
- B↔C는 예시 노출만 비교한다. A↔C로 두 변경을 섞지 않으며 실제 선택기나 자연스러움 성공으로
  표현하지 않는다. 이 입력 준비 당시에는 제품 코드·정식 테스트를 변경하지 않았다.

## 고정 입력 모델 경로 연결과 현재 실행안

- 후속 진행 요청으로 `eval:persona-comparison`을 구현했다. 고정 Persona/case hash, fresh target,
  clock, hidden state, 조건별 prompt provenance를 기존 HTTP/provider 경로에서 검사한다.
  클라이언트 재시도 0회, tools/embedding 없음, 실패·잘린 응답에서 중단하고 앞선 응답을 보존한다.
- 실제 source CLI 합성 응답 96건 통과, 외부 모델 0회. 두 review 패킷은 각각 32쌍이며
  같은 캐릭터와 같은 prefix끼리만 비교한다. 원문·이름은 그대로, 조건·모델은 가린다.
  사용자 1인 검수용이며 `both_bad`를 지원한다. 기존 2인 agreement 집계는 사용하지 않는다.
- 사용자가 설정이 DB에 있다고 알려줘 `opod.admin_settings`를 읽기 전용 확인했다.
  `agent`의 OpenRouter `xiaomi/mimo-v2.5-pro`가 선택되며 API 키는 존재 여부만 확인했다.
  `.env` 경로를 다시 묻지 않는다. 실제 실행 때 DB 설정을 메모리에서 읽고 고정하되 키는 출력·저장하지 않는다.
- 기존 ignored source 디렉터리의 `comparison-smoke-manifest.json`과
  `comparison-smoke-execution-contract.json`이 12회 실행안이다. 인사 1상황 × 4명 × 3조건,
  temperature 1 / top_p 0.95 / max_tokens 8192 / 재시도 0이다. 현재 공개 가격을 적용한
  사전 보수적 추산은 약 $0.24이며 강제 달러 한도는 아니다. 사용자가 이 범위를 승인한 뒤
  17:40:42 KST에 12회 모두 정상 종료했다. 실제 청구액은 $0.020053869다.
- OpenRouter 자동 routing/reasoning 기본값을 사용하는 smoke는 연결 확인과 초기 검토 범위다.
  본 비교 전에 upstream/reasoning 조건을 정해야 하며 288회로 자동 확대하지 않는다.
  자세한 근거·한계는 [연결 검증과 실행안](character-chat-s1-examples-review-2026-09-07.md)에 있다.
- 실제 모델 artifact는 `comparison-smoke-model-run/`에 있다. 12개 response ID와 token count,
  preflight와 동일한 prompt metadata, source/case hash, 검수 8쌍, 권한·gitignore 등 32개 검증을 통과했다.
  `review-1.md`와 `review-2.md`가 사용자 검수 파일이며 private key는 최초 검수 때 보여주지 않는다.
- metadata GET 12회에서 Xiaomi 7 / GMICloud 2 / DigitalOcean·DeepInfra·Novita 각 1회를 확인했다.
  실제 모델 정식 ID는 모두 `xiaomi/mimo-v2.5-pro-20260422`로 공개 alias mapping과 일치한다.
  reasoning 보고값 차이와 인사 1상황·1반복의 제한 때문에 구조 개선의 효과로 판정하지 않는다.
- 최초 계약 JSON의 승인 대기 상태는 역사적 기록이다. `comparison-smoke-run-authorization.json`에
  후속 사용자 승인이 있고 실행도 끝났으므로 같은 12회 승인을 다시 묻거나 자동 재실행하지 않는다.

## 다음 실행 순서

1. 현재 계획 10~11절과 S1 보고서를 읽는다. 원문 저장 승인은 해소됐고 15:22 snapshot이 있다.
   불필요하게 재조회하지 않는다. 승인된 모델 12회는 완료됐고 DB 쓰기·DDL은 하지 않았다.
2. 혼합 8개/22구간 분리는 승인·완료됐다. `source-projection.json`과 최종 artifact를 사용한다.
   기존 `mixed-block-proposal.*`의 승인 전 status는 역사적 기록이며 승인을 다시 묻지 않는다.
3. 완료된 smoke의 조건을 가린 두 패킷을 사용자가 검수한다. 사용자 답변을 생성하거나
   대신 PASS를 넣지 않는다. 최종 제품 정책·실제 selector는 후속 결정이다.
4. smoke 원문 검토 뒤 제공사/reasoning을 통제한 본 비교 조건을 확정해 Legacy와 사전 선택 Routed를 같은
   모델·원문·canon·hidden state로 새로 생성한다. 첫 국소 비교를 전체 mapping 완성까지 미루지 않는다.
   단순 fixture selector나 기본 empty 선택을 실제 retrieval 검증으로 세지 않는다.
5. 사용자 검수에서 이득이 보이면 실제 selector와 미사용 case, 긴 대화에서 재검증한다.
   조건과 source badge는 최초 판단 때 가리며 캐릭터성·회상·한국어 회귀를 함께 본다.
6. 이득이 없거나 혼재하면 canon, context 순서, 시간/Bond 지침, 표현·모델 중 근거가 가리키는
   원인을 하나씩 검증한다. Memory Gate와 Current State를 자동으로 다음 구현에 넣지 않는다.
7. 확인된 효과가 유지되는 변경만 적용 후보로 남긴다. schema 변경은 최소 필요와 rollback을
   별도로 승인받으며, Persona/character lore/사용자 Memory 효과를 하나로 합쳐 주장하지 않는다.

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

최신 실제 모델 검증 결과:

- 승인된 CLI `run --max-calls 12` exit 0. 12회 모두 같은 요청 모델, finish reason `stop`.
- prompt metadata가 기존 합성 preflight와 동일하고 실제 artifact 독립 검증 32개 통과.
- generation GET 12회의 청구액·제공사·정식 모델 ID·native token count를 대조했다. 추가 모델 생성 0회.
- 이번 턴은 실행 artifact와 결과/계획 문서만 갱신했다. 제품/eval 코드 변경이 없어 전체 테스트를 재실행하지 않았다.

이전 모델 경로 연결의 검증 결과:

- `test:coverage`: 제품 280개 통과, Postgres 통합 14개 skip, coverage gate 통과.
- `test:eval:coverage`: 평가 78개 통과, coverage gate 통과.
- runtime/eval typecheck, lint, production build, root workspace dead-code 통과.
- 기존 HTTP/provider 경로의 실제 source CLI 합성 completion 96건 통과, 외부 모델·embedding 0회.
- 로컬 HTTP 모의 서버에서 실제 SDK 요청·응답, 429 재시도 0, 잘린 응답 보존·중단 검증.
- 실제 요청 payload의 추가 합성 12건으로 smoke 설정·입력 byte 수를 확인했다.
- 별도 12회 CLI smoke preflight도 통과했다. 전체 합성 artifact 108응답·72쌍의 독립 대조 35개 검사,
  기존 `eval:validate` H30 8개 시나리오, `git diff --check` 통과.
- 웹은 미변경·미재검증. 전체 dead-code는 미설치 웹 의존성 문제를 남기며 root workspace만 통과했다.

이전 examples 입력 준비의 검증 결과:

- 기존 ChatService 프롬프트 준비 96건 통과, chat/embedding 호출 0회.
- examples 54구간의 원문 재조립과 source/기존 분리 입력 hash 불변성, ignore·권한 검증 통과.
- 제품 코드·정식 테스트 변경이 없어 제품/eval 전체 테스트는 이번 입력 조사에서 재실행하지 않았다.

이전 S1 분리 구현의 검증 결과:

- `test:coverage`: 제품 280개 통과, Postgres 통합 14개 skip, coverage gate 통과.
- `test:eval:coverage`: 평가 65개 통과, coverage gate 통과. 분리 회귀 테스트 10개 포함.
- runtime/eval typecheck, lint, production build 통과.
- 전체 dead-code 검사는 미설치 웹 의존성 때문에 실패했다. 변경 범위에는
  `npm run dead-code -- --workspace .`를 실행해 통과했다. 웹 검증은 이번 단계에서 재실행하지 않았다.
- 원문 byte 보존·37개 블록·4개 examples·79개 canon 보존과 실제 source 배치 12건 통과.

이전 P1-1 구현 당시의 전체 검증 결과(웹 결과를 현재 실행 결과로 사용하지 않는다):

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
- `evals/persona-source-projection.ts`: 평가 전용 원문 구간 분리와 내용 없는 source map
- `evals/persona-source-projection-cli.ts`: 로컬 입력 투영·구조 probe·격리 artifact 생성
- `evals/persona-comparison.ts`: pinned 입력 검증과 fresh target의 고정 prefix 비교
- `evals/persona-comparison-cli.ts`: 호출 상한·응답/재현 기록·같은 캐릭터 사용자 검수 패킷
- `evals/target.ts`: 고정 Persona/clock/selector와 기존 HTTP/provider 연결
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
- `repo-evidenced`: 개발 DB의 4/45/79 snapshot으로 첫 모델 smoke 12회를 완료했다. 전체 mapping·실제 selector·반복 본 비교는 미검증이다.
- `user-confirmed`: 혼합 8개/22구간만 실험 입력에서 분리하며 examples와 canon을 유지한다.
- `repo-evidenced`: 분리 결과의 주입은 기존 Router가 소유한다. 실험 사용법은 `evals/README.md`에 기록했다.
- `repo-evidenced`: 고정 prefix 비교도 기존 HTTP target/provider와 review가 소유한다. 인증값 없는
  실행·재현 기록과 실패 시 응답 보존, 1인 검수의 한계를 `evals/README.md`에 추가했다.
- `repo/externally-evidenced`: 모델명은 같지만 실제 제공사·reasoning 보고가 달랐다. 결과 보고서와
  계획 정본에 본 비교의 통제 필요성을 반영했으며, 제품 품질 개선으로 승격하지 않았다.
- 계획 재검토: 원인 가설과 관측을 분리하고 실제 selector·캐릭터성·회상·holdout 검증을 추가했다.
  연구 순서는 확정 제품 정책으로 승격하지 않는다. 정본은 연결된 연구 문서의 10~11절이다.
