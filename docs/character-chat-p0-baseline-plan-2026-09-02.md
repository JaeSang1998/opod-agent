# P0 계획 — 캐릭터 챗 품질 Baseline과 사람 평가 보정

- 작성일: 2026-09-02
- 상태: P0 평가 기반과 1인 사후검수 seed 구현 완료, P0-R1 공통 응답 정책 반영·judge 없는 전체 대화 8개와 동일 문맥 25회 실행 완료, 사용자 재검수 전
- 범위: `opod-agent` 평가·관측 코드와 문서, 별도 승인된 P0-R1 공통 응답 정책
- 연구 근거: [`character-chat-architecture-research-2026-09-02.md`](character-chat-architecture-research-2026-09-02.md)
- 기존 평가 계약: [`long-conversation-eval.md`](long-conversation-eval.md), [`../evals/README.md`](../evals/README.md)

> 2026-09-03 후속 실행 결정: 이번 P0-R1 답변 개선은 사용자가 기존 스모크 원문에 직접 남긴
> 22개 사후검수 주석만 개선 입력으로 사용한다. 추가 reviewer 모집과 blind calibration은 보류한다.
> 이 결정은 단일 사용자 검수를 gold로 승격하지 않으며, seed의
> `reviewerCount: 1`, `blind: false`, `method: posthoc` 표기를 유지한다.

## 1. P0의 목적

P0의 산출물은 “답변이 좋아졌다”가 아니라 **현재 답변이 왜 나쁜지 재현하고, 이후 변경의
효과를 같은 조건에서 비교할 수 있는 기준선**이다.

P0가 답해야 할 질문은 다음과 같다.

1. 같은 모델과 Persona에서도 실패가 반복되는가, 아니면 sampling 변동인가?
2. 실패의 1차 소유자는 context, Persona, Memory, model, UX 중 어디인가?
3. 같은 실패가 여러 캐릭터에서 재현되는 공통 결함인가, 특정 Persona data의 결함인가?
4. 짧은 후속 발화와 정정 실패가 retrieval 문제인지 history/context 순서 문제인지 구분되는가?
5. 자동 judge가 한국어 사람이 느끼는 자연스러움과 어느 정도 일치하는가?
6. P1에서 가장 먼저 바꿔야 할 한두 개 seam은 무엇인가?

P0 완료는 Persona, retrieval, Bond, DB schema, Admin 데이터를 변경하지 않는다. 답변 경로의
동작을 바꾸기 전 관측과 평가 계약을 만드는 단계다.

## 2. 범위와 승인 경계

### 포함

- 실행마다 candidate/simulator/judge와 generation 설정, suite/git/Persona fingerprint 기록
- 기존 H30 검사에 자연스러움 **진단 지표**를 additive하게 확장
- H30 release gate와 분리된 캐릭터 공통 naturalness baseline suite
- 공통 scenario × runtime character-set 전체의 교차 실행과 누락 검증
- 실패 taxonomy와 turn evidence
- synthetic/curated transcript 기반 blind human calibration 절차
- 현재 시스템 baseline 실행과 분석 보고서

### 제외

- 원래 P0 baseline 범위에서의 system prompt 순서나 Persona block 내용 변경. 단, 2026-09-03에
  별도로 승인된 P0-R1은 모든 캐릭터가 공유하는 자연스러운 응답 정책만 변경한다.
- retrieval query, relevance threshold, Memory write lifecycle 변경
- Bond/반말 정책 변경
- Character World State 구현
- DB migration 또는 Admin write
- production 배포, fine-tuning, UI/streaming 변경
- 사용자 동의가 확인되지 않은 production transcript 원문 반입

공통 suite·character-set 계약·교차 실행·coverage 집계까지는 구현 승인됐다. 실제 모델 호출과
production transcript 사용은 이 승인에 포함되지 않으며 별도의 실행·데이터 정책 결정으로 남긴다.

## 3. 성공 기준

P0는 다음 조건을 모두 만족할 때 완료다.

1. 두 artifact가 비교 가능한 실행인지 manifest만 보고 판단할 수 있다.
2. 실제 target이 사용한 stable prompt의 content-free SHA-256, Persona block 수, canon 수가
   기록된다. 평가 fixture의 Persona 정보만 기록하고 이를 실제 prompt snapshot이라고 부르지
   않는다.
3. 기존 H30 8개 scenario, 점수식, certification 조건, Harbor artifact는 후방 호환된다.
4. 공통 naturalness suite 8개 scenario를 runtime character-set 전체에 scenario당 12 exchange,
   3개 seed로 실행할 수 있다.
5. 새 지표는 threshold 보정 전 release hard gate가 아니라 diagnostic으로 표시된다.
6. 모든 실패 tag에는 turn 번호, 발췌, 1차 owner category가 있다.
7. 최소 2명의 사람이 출처를 가린 transcript를 독립 평가할 수 있는 guide와 label artifact가
   있다. 1명만 평가하면 결과는 계속 provisional이다. 현재는 tooling만 유지하고 실제 추가 검수는
   사용자 결정에 따라 보류한다.
8. blind review를 재개할 경우 judge-human agreement, false-pass, false-fail을 보고하고 그 결과로
   threshold 유지·수정·폐기를 결정한다. 재개 전까지 자동 judge는 release gate가 아니다.
9. baseline report가 P1 후보를 영향도·재현성·구현 seam 기준으로 정렬한다.
10. 한 캐릭터 또는 한 `character:scenario` cell이 누락되면 전체 baseline을 완료로 표시하지 않는다.
11. 공통 구현과 suite에는 운영 캐릭터 ID·이름·전용 motif·조건 분기가 없다.
12. 원래 P0 평가·관측 변경 전후 candidate reply bytes는 동일 입력·seed·외부 상태가 같을 때
    달라지지 않는다. 별도로 승인된 P0-R1은 reply policy를 의도적으로 변경하므로 이 동일성 조건의
    대상이 아니며, 새 stable prompt fingerprint로 전후 실행을 구분한다.

## 4. 가정

- 개발 DB의 활성 캐릭터 집합과 각 character UUID·active Persona snapshot은 실행 환경에서
  read-only로 얻는다. character-set의 선언 개수와 실제 활성 개수가 다르면 quality run을 중단한다.
- runtime character-set은 git 밖의 파일이 소유한다. 공통 suite와 코드는 운영 캐릭터 식별자를
  하드코딩하지 않는다.
- candidate, simulator, judge는 서로 다른 model ID를 사용한다. 연결 확인을 위한 동일 모델
  smoke run은 품질 근거로 세지 않는다.
- 첫 baseline은 고유 eval user/session ID를 사용해 관계 기억이 비어 있는 상태에서 시작한다.
  기존 사용자의 기억을 섞지 않는다.
- generation parameter를 provider가 지원하지 않으면 “지원하지 않음/무시됨”을 manifest에
  명시한다. 설정값을 보냈다는 사실과 provider가 적용했다는 사실을 혼동하지 않는다.
- production log 원문은 기본 입력이 아니다. synthetic trajectory와 명시적으로 검수된 fixture를
  먼저 사용한다.

## 5. Existing Owner Check

새 기능을 별도 도구로 중복 구현하지 않고 현재 소유자에 붙인다.

| Capability | 판정 | 기존 소유자 | P0 처리 |
| --- | --- | --- | --- |
| Scenario schema/loader | owner-found | `evals/schema.ts`, `evals/cases/*.json` | diagnostic suite mode만 additive 확장 |
| Runtime character-set schema/loader | owner-found | `evals/schema.ts` | 완전성·고유성 검증을 같은 loader 경계에 추가 |
| Trajectory 실행과 judge | owner-found | `evals/evaluate.ts` | 같은 report에 diagnostics/taxonomy 추가 |
| 질문 비율·질문 streak | owner-found | `evals/evaluate.ts` | 재구현하지 않고 suite-level로 집계 |
| 길이·near duplicate·형식 | owner-found | `evals/evaluate.ts` | 기존 evidence를 재사용하고 분포만 추가 |
| latency/token 수집 | owner-found | `evals/target.ts`, `evals/atif.ts` | p50/p95 집계 추가 |
| suite hash/git SHA/artifact write | owner-found | `evals/cli.ts` | baseline manifest 확장 |
| production request/response telemetry | owner-found | `src/provider/logged-llm-provider.ts` | 별도 logger를 만들지 않음 |
| H30 계약 문서 | owner-found | `docs/long-conversation-eval.md`, `evals/README.md` | 의미가 바뀌는 부분만 동기화 |
| 실제 assembled prompt fingerprint | owner-absent | 없음 | debug 요청에서 hash/count만 제공 |
| Human blind/pairwise workflow | owner-absent | 원칙만 문서에 존재 | guide/schema/artifact 신규 작성 |
| P0 baseline 분석 보고서 | owner-absent | 없음 | 실행 후 날짜가 붙은 report 신규 작성 |

`src/provider/logged-llm-provider.ts`는 system/user/request JSON, latency, token, model, finish
reason과 redaction을 이미 저장한다. P0는 이를 복제하지 않는다. Eval artifact에는 원문 prompt를
추가 저장하지 않고 비교용 fingerprint와 count만 남긴다.

## 6. 실패 Taxonomy

한 실패에 여러 tag가 붙을 수 있지만 1차 owner는 하나만 선택한다. “모델이 멍청함”은 원인이
아니므로 허용 tag가 아니다.

| Owner | Code | 판정 질문 | 대표 증상 |
| --- | --- | --- | --- |
| Context | `CTX_LOCAL_MISS` | 최근 2~4턴을 줬다면 해결됐는가? | `그건 왜?`의 지시 대상 누락 |
| Context | `CTX_ORDER_INTERFERENCE` | user text가 context 뒤에 있었다면 달랐는가? | Memory/Bond를 답하고 사용자 의도는 약하게 받음 |
| Context | `CTX_OPEN_LOOP_LOSS` | 현재 주제·미완료 질문 상태가 없어서 생겼는가? | 중단 뒤 복귀 실패 |
| Context | `CTX_WORLD_STATE_ABSENT` | 캐릭터의 현재 활동 정본이 없어서 생겼는가? | `뭐 해?`마다 근황이 달라짐 |
| Persona | `PER_GENERIC` | 캐릭터를 빼도 같은 답인가? | 무난한 상담원 문구 |
| Persona | `PER_MOTIF_FORCED` | 캐릭터 키워드가 상황보다 앞섰는가? | 모든 일을 운동·기록·승부로 바꿈 |
| Persona | `PER_RULE_COLLISION` | 서로 다른 channel의 지침이 충돌했는가? | 촬영/콘텐츠 지침이 DM에 나타남 |
| Persona | `PER_EXAMPLE_MIMICRY` | few-shot 문구/구조를 기계적으로 복제했는가? | 매번 `인정 → 정리` |
| Memory | `MEM_RETRIEVAL_MISS` | 유효한 기억이 있었지만 못 찾았는가? | 이전 면접을 못 기억함 |
| Memory | `MEM_FORCED_RECALL` | 관련성 낮은 기억을 억지로 썼는가? | 인사에 오래된 취향을 과시 |
| Memory | `MEM_STALE_OR_CONFLICT` | 정정·만료된 사실이 다시 나왔는가? | 민수 정정 뒤 옛 이름 사용 |
| Memory | `MEM_UNGROUNDED_INFERENCE` | 추론을 확정 사실처럼 말했는가? | 감정·관계를 단정 |
| Memory | `MEM_PRIVACY_OR_FORGET` | 저장 동의·망각 요청을 지키지 못했는가? | 잊어달라는 사실을 다시 사용 |
| Model | `MOD_INSTRUCTION_DRIFT` | 같은 context에서 형식/경계를 놓쳤는가? | Markdown, 장문, 내부 tag 노출 |
| Model | `MOD_VARIANCE` | 같은 snapshot/seed군에서 결과가 불안정한가? | 3회 중 pass/fail 혼재 |
| UX | `UX_LATENCY` | 내용과 별개로 기다림이 대화를 깨는가? | 높은 p95/긴 무응답 |
| UX | `UX_TURN_SHAPE` | 완성 답 한 bubble만 전달하는 방식의 문제인가? | 너무 완결적이고 끼어들 틈 없음 |

판정 순서는 `입력에 필요한 사실이 있었는가 → 올바른 context가 모델에 들어갔는가 → Persona/
Memory가 방해했는가 → 같은 입력에서도 모델이 놓쳤는가 → 전달 경험이 문제인가`다. 이 순서를
지켜 Persona 문구로 context 결함을 덮지 않는다.

## 7. 구현 Slice

### P0-0. Baseline preflight

목표는 비용이 드는 실행 전에 비교 불가능한 상태를 차단하는 것이다.

작업:

- candidate/simulator/judge model ID가 서로 다른지 확인
- target endpoint 종류(`in-process`/`http`)와 health 확인
- multi-character diagnostic은 현재 synthetic Persona 하나뿐인 in-process target을 금지하고
  `EVAL_TARGET_URL`을 요구
- 활성 캐릭터 전체의 effective ID, active Persona/canon count와 snapshot 시각 확인
- runtime character-set의 `expectedCharacterCount`와 활성 캐릭터 수 일치 확인
- model request parameter와 provider 지원 여부 기록
- git dirty state와 HEAD SHA를 모두 기록하되 사용자 변경 파일은 수정하거나 stash하지 않음
- 고유 eval user/session을 사용하고 시작 memory state가 빈 상태인지 확인
- suite schema validation과 test double 회귀 테스트 실행

중단 조건:

- 활성 캐릭터 하나라도 Persona를 읽지 못하거나 character-set에서 빠지면 quality 실행을 중단하고
  synthetic wiring smoke만 수행
- 세 모델이 분리되지 않으면 결과에 `non-certifying/self-judge`를 강제 표시
- parameter 적용 여부를 확인할 수 없으면 그 필드를 `unknown`으로 두고 비교 주장 금지

### P0-1. 재현 가능한 run manifest

구현 상태(2026-09-02): production reply policy를 바꾸지 않고 완료했다. `ChatService.prepare`가
실제로 조립한 stable prompt의 SHA-256과 content-free count/context 관측값을 만들고, 기존
`x-opod-debug` non-streaming 응답이 opt-in일 때만 이를 전달한다. Eval target은 허용 필드만 parsing해
trajectory에서 실행 중 fingerprint/model drift를 거부한다. CLI는 Git worktree, suite/character-set,
model/config 관측값을 합쳐 `suite-report.json.baseline`과 동일한 `baseline-manifest.json`을 쓴다.
실제 endpoint 실행 결과와 개발 DB character snapshot 확인은 아직 남아 있다.

#### Artifact 계약

`suite-report.json`에 additive `baseline` metadata를 넣고, 사람이 빠르게 비교할 수 있도록 같은
내용의 `baseline-manifest.json`도 root output에 쓴다.

```text
schemaVersion
runGroupId
startedAt
targetKind, endpointOrigin
candidateModel, simulatorModel, judgeModel, judgeReplicas
requestedGenerationConfig
observedResponseModel
gitHeadSha, gitDirty, dirtyPathHashes
suitePath, suiteSha256, profile, baseSeed, runCount
characterSetPath, characterSetSha256, characterSetLabel, characterSetCapturedAt
expectedCharacterKeys, completedCharacterKeys, missingCharacterScenarioCells
perCharacter[]       characterId, publicKey, personaVersion
                     stablePromptSha256, personaBlockCount, canonCount
memoryPolicyVersion, retrievalConfig, consolidationMode
fingerprintSource       observed / declared / unavailable
calibrationStatus       uncalibrated / provisional / calibrated
```

비밀키, full prompt, 사용자 발화 원문, DB URL은 manifest에 넣지 않는다. `endpointOrigin`도 필요한
경우 environment label로 대체할 수 있다.

#### 실제 prompt fingerprint

기존 `x-opod-debug: 1` 경로에 다음 content-free metadata만 추가하는 방식을 권장한다.

- `stablePromptSha256`
- `personaBlockCount`
- `canonCount`
- `contextSectionNames`
- `retrievedMemoryCount`

원문 Persona/Memory, memory ID, user ID는 debug metadata에 넣지 않는다. 소유 seam은
`src/chat/chat-service.ts` → `src/chat/http-route.ts` → `evals/target.ts` →
`evals/evaluate.ts`다. 일반 응답 content와 streaming bytes는 변경하지 않는다. Debug header가
없는 요청에는 metadata가 노출되지 않아야 한다.

검증:

- 같은 Persona와 tools 구성은 같은 stable hash
- Persona 한 글자 또는 canon 하나가 바뀌면 다른 hash
- dynamic time·user memory 변화는 stable hash를 바꾸지 않음
- debug off 응답과 일반 reply text가 변경되지 않음
- artifact에 prompt 원문이 없음

### P0-2. 자연스러움 diagnostics와 evidence

#### 결정론적 descriptive metric

기존 check 결과를 다시 계산하지 않고 내부 원자료를 공통 helper로 승격해 trajectory와 suite에
다음 분포를 기록한다.

| Metric | 용도 | Gate 여부 |
| --- | --- | --- |
| assistant chars p50/p90/max | 장문·획일적 길이 탐지 | diagnostic |
| user 대비 reply expansion p50/p90 | 단답에 과도한 설명 탐지 | diagnostic |
| question-ending rate | 질문 공세 탐지, 기존 값 재사용 | 기존 scenario check 유지 + aggregate diagnostic |
| maximum question streak | 기계적 인터뷰 탐지, 기존 값 재사용 | 기존 scenario check 유지 + aggregate diagnostic |
| near-duplicate pairs | 반복 답변, 기존 값 재사용 | 기존 check 유지 |
| repeated opening phrase rate | `아 그랬구나`, `말해줘서 고마워` 같은 시작 반복 | diagnostic |
| prompt/completion token p50/p95 | prompt 비대와 비용 변화 | diagnostic |
| latency p50/p95/max | UX 병목 분리 | diagnostic |

한국어의 “조언”, “자기 노출”, “상담원 문구”를 regex만으로 hard gate하지 않는다. 이는 judge와
사람이 turn evidence를 붙여 평가한다. 새로운 숫자 threshold도 human calibration 전에는
release gate에 연결하지 않는다.

#### Judge diagnostic

기존 공통 rubric을 삭제하지 않고 다음 자연스러움 dimension과 typed failure code를 별도
diagnostic 결과로 추가한다.

- `local_relevance`
- `mutuality`
- `conversational_rhythm`
- `persona_without_motif`
- `advice_restraint`
- `memory_discretion`
- `register_continuity`
- `repair_quality`

각 dimension은 1~5점, confidence, 1개 이상의 유효한 turn evidence를 가져야 한다. Critical
failure enum과 H30 pass 식은 그대로 둔다. P0 diagnostic 점수가 좋아도 H30 release 조건을
우회할 수 없다.

#### 예상 변경 소유자

- `evals/evaluate.ts`: metric 집계, diagnostic report, typed taxonomy
- `evals/schema.ts`: diagnostic suite mode와 rubric validation
- `evals/atif.ts`: final metrics에 additive summary
- `evals/evaluate.test.ts`: 계산·evidence·false-pass 회귀
- `evals/README.md`: 실행과 artifact 설명

### P0-3. 캐릭터 공통 Naturalness baseline suite

#### H30과 분리하는 이유

H30은 24 exchange 장기 continuity release contract다. 첫인사·칭찬·짧은 후속 발화 같은
micro-naturalness를 넣기 위해 H30 threshold를 낮추거나 certification 의미를 바꾸면 안 된다.
Top-level `mode: "h30" | "diagnostic"`을 추가하고 기존 suite는 default `h30`으로 유지한다.

Diagnostic mode는 다음 규칙을 따른다.

- `certificationEligible`은 항상 `false`
- quality score와 evidence는 출력하지만 `H30 PASS`로 표현하지 않음
- process exit는 model/runtime/judge/artifact 완결성 실패에만 nonzero
- threshold는 `P0-provisional`로 표시
- 기존 H30 aggregate와 Harbor reward 수식은 변경하지 않음

#### Scenario 파일

공통 파일: `evals/cases/character-naturalness-baseline.json`

각 scenario는 특정 캐릭터의 이름·motif·모범 답안을 포함하지 않는 12 exchange 계약이며 scripted
anchor 사이를 simulator가 잇는다. 실행기는 runtime character-set의 모든 항목과 scenario를
교차한다. 개발 DB 기준 현재 4명이라 standard는 32 trajectory, confidence는 96 trajectory다.

| Scenario ID | 핵심 probe | 현재 예상 실패를 정답으로 고정하지 않는 이유 |
| --- | --- | --- |
| `bare-opening-mutuality` | `ㅎㅇ`, `심심해`에서 질문 없이도 가볍게 기여 | 질문 0개가 목표가 아니라 상호성의 적절성 평가 |
| `everyday-world-state-restraint` | `뭐 해`, 어제·오늘 자기 일상 연속성과 근거 절제 | 특정 활동 문구를 모범답안으로 만들지 않음 |
| `compliment-playful-reciprocity` | 칭찬 수용, 장난, 작은 되받아침 | 고유 motif 횟수보다 상황 적합성 평가 |
| `short-followup-local-context` | `그건 왜`, `아니 그거`, 주제 복귀 | exact keyword 없이 최근 맥락 이해 평가 |
| `low-energy-no-interview` | 단답이 이어질 때 질문 streak와 여백 | 무조건 질문 금지가 아니라 압력 평가 |
| `emotion-advice-consent` | 위로만 요청, 뒤늦은 조언 요청 | 같은 세션에서 consent 전환을 추적 |
| `register-negotiation-repair` | 존댓말·반말 요청, 질문 지적, 사과 복구 | 단일 Bond level이 아닌 상호 협상 평가 |
| `memory-correction-forget-restraint` | 관련 회상, 이름 정정, 망각 요청 | 현재 미지원 능력도 baseline failure로 기록 |

운영 DB UUID와 이름은 fixture에 하드코딩하지 않는다. `--characters` 또는
`EVAL_CHARACTER_SET_PATH`로 git 밖의 runtime snapshot을 주입한다. 각 항목은 stable `key`, 실제
target `id`, 표시 이름, judge용 Persona summary/canon을 가진다. `expectedCharacterCount`는 2 이상이며
배열 길이와 같아야 하고 `key`·`id`는 고유해야 한다. 개발 baseline preflight는 이 선언이 해당
시점의 active character 전체와 일치하는지 read-only로 확인한다.

현재 구현된 기반:

- top-level `mode: "h30" | "diagnostic"`과 기존 H30 default
- runtime character-set schema/loader와 완전성·고유성 검사
- 공통 scenario × character-set × run의 교차 실행
- 전체 scenario 통계, 캐릭터별 통계, 누락 `character:scenario` cell 보고
- 전체 평균과 별도로 캐릭터별 최소 pass rate·평균 점수 미달을 보고하고 quality pass 차단
- diagnostic trajectory/suite의 H30 certification 차단
- 실제 served stable prompt의 content-free SHA-256·Persona block/canon 수 관측
- dynamic context section·retrieved memory 수의 turn별 content-free 관측
- observed response model과 실행 중 prompt/model drift 검증
- Git HEAD·dirty path SHA-256을 포함한 `baseline-manifest.json`과 비교 가능성 사유

#### 검증

- 새 suite schema validate
- 실제 운영 식별자가 공통 코드와 suite에 없음
- scripted anchor가 모든 12-turn 범위와 phase를 정확히 덮음
- protected fact가 recall probe 전 simulator prompt에 새지 않음
- diagnostic suite가 `certificationEligible: false`이고 H30 suite는 기존 결과 유지
- 하나의 character-scenario cell을 빼면 coverage가 실패
- simulator의 조기 exit와 judge contract failure가 성공으로 처리되지 않음

### P0-4. Human gold와 judge calibration

2026-09-03 실행 상태: **보류**. 사용자는 이번 개선을 본인이 남긴 22개 주석만으로 진행하도록
결정했다. 기존 review guide, packet tooling과 2인 독립 검수 계약은 삭제하거나 약화하지 않지만,
추가 reviewer를 모집하거나 미완료 packet을 P0-R1의 blocker로 취급하지 않는다. 현재 seed는 계속
`single-user/posthoc/uncalibrated`다.

#### 기본 데이터 정책

초기 gold set은 다음만 사용한다.

- 새 naturalness suite에서 생성한 synthetic trajectory
- 실제 운영 Persona에 귀속되지 않는 사람이 작성한 공통 good/bad/edge trajectory
- 필요하면 runtime character-set별 생성 trajectory를 출처를 가린 상태로 균형 표집
- 민감정보가 없는 사람이 직접 작성한 good/bad/edge 변형

Production transcript는 기본적으로 사용하지 않는다. 추후 사용하려면 별도로 다음을 결정해야
한다.

- 사용자 동의 또는 적법한 처리 근거
- 자동·수동 비식별화 기준
- reviewer 접근 권한
- 원문과 label의 보존 기간
- 탈퇴·망각 요청의 전파
- git 및 일반 artifact에 원문을 넣지 않는 저장 위치

#### Review 단위

1. 전체 대화 pairwise: 출처·model·캐릭터 순서를 가리고 “어느 쪽이 사람과 하는 캐릭터 DM에
   더 가까운가”를 선택한다.
2. 단일 trajectory rubric: local relevance, mutuality, Persona, memory discretion, register,
   repair를 1~5로 채점한다.
3. Turn tag: 실패가 있는 최소 turn과 taxonomy code를 표시한다.

두 reviewer가 독립 평가하고 불일치만 합의 리뷰한다. 순서 효과를 줄이기 위해 A/B 위치를
무작위화하고 같은 reviewer에게 동일 pair를 중복 노출하지 않는다.

#### Artifact

- `docs/evals/naturalness-human-review-guide.md`: 예시와 경계가 있는 annotation guide
- `evals/calibration/naturalness-gold.schema.json`: transcript ID, pair order, labels, evidence 계약
- synthetic gold index: 저장소에 commit 가능
- production-derived index/raw text: 정책 승인 전 생성 금지, 생성해도 git 제외
- 실행 결과: `evals/results/<run>/human-calibration.json`

#### Calibration report

다음을 보고한다.

- pairwise judge-human agreement
- rubric dimension별 exact/within-one agreement
- good gold의 false-fail, bad gold의 false-pass
- critical failure false-pass
- reviewer 간 agreement와 주요 불일치 사례
- 유지·수정·폐기할 judge 문구와 threshold

수치가 낮으면 judge를 평균내서 감추지 않는다. P0 결과는 “judge를 release gate로 사용할 수
없다”일 수도 있으며, 그것도 유효한 결론이다.

### P0-5. Baseline 실행과 분석

#### 실행 순서

1. preflight manifest 초안을 만들고 비교 불가 조건을 확인한다.
2. 무료 검증을 통과시킨다.
3. naturalness smoke 2 scenario × 모든 캐릭터 × 6 exchange로 세 모델과 artifact 경로를 확인한다.
4. naturalness 8 scenario × 모든 캐릭터 × 12 exchange × 1 run을 실행해 scenario 결함을 찾는다.
5. fixture가 안정되면 3 seed confidence baseline을 실행한다.
6. 기존 H30 confidence를 같은 candidate snapshot으로 실행한다.
7. 현재 iteration은 기존 사용자 사후검수를 기준으로 분석한다. 독립 human review와 judge
   calibration은 사용자 결정으로 보류하며, 그동안 자동 판정을 품질 통과 근거로 사용하지 않는다.
8. 실패 분포, p10/최악 trajectory, model variance, token/latency를 분석한다.
9. P1 후보를 `영향도 × 재현성 ÷ 변경 위험` 순으로 정렬한다.

#### 2026-09-03 P0-R1 실행 기록

- 개발 DB의 활성 캐릭터 4명과 활성 Persona 45블록·Canon 79개를 일회용 로컬 DB에
  read-only로 격리하고, 캐릭터별 분기 없이 같은 공통 응답 정책으로 실행했다.
- judge를 끈 전체 대화 smoke는 8/8 대화·48/48 후보 응답을 완주했다. 이 실행의
  `quality=PASS`와 `CONNECTED`는 연결·완주 상태일 뿐 자연스러움 판정이 아니다.
- 기존 사용자 리뷰 22개가 가리킨 턴 및 대화 전체 범위를 합쳐, 기존 대화의 보이는 prefix가
  동일한 25개 지점을 추가 재생했다. 관계 상태와 사용자 Memory는 각 지점에서 초기화했다.
- 현재 suite가 이전 실행 이후 바뀌어 전체 대화의 사용자 발화 48개 중 36개가 달라졌다. 따라서
  전체 대화 8개는 흐름 검수용이고, 변경의 직접 인과 비교는 동일 문맥 25개만 참고한다.
- 새 답변에는 자동 품질 라벨을 붙이지 않았다. 원문과 제한 사항은
  [`reports/character-chat-p0-before-after-2026-09-03.md`](reports/character-chat-p0-before-after-2026-09-03.md)에 기록했다.

#### 결과 문서

실행 뒤 `docs/reports/character-chat-p0-baseline-YYYY-MM-DD.md`를 만든다.

필수 내용:

- manifest 요약과 비교 가능 여부
- naturalness/H30 결과를 서로 다른 표로 표시
- dimension별 중앙값·p10·3-run range
- taxonomy owner별 실패 건수와 대표 evidence
- 가장 좋은 trajectory보다 가장 나쁜 trajectory 분석
- prompt token, completion token, latency p50/p95
- human/judge agreement와 provisional 상태
- P1 추천 1~3개, 보류한 가설, 반증된 가설
- 품질 향상을 주장할 수 있는지 여부

## 8. 파일 단위 예상 변경

| 파일 | 변경 | 비고 |
| --- | --- | --- |
| `src/chat/chat-service.ts` | stable prompt hash/count debug metadata 생성 | reply policy 불변 |
| `src/chat/http-route.ts` | 기존 debug 응답에 content-free metadata 추가 | debug off 불변 |
| `src/chat/*.test.ts` | hash 안정성·비노출·reply 동일성 | production 회귀 |
| `evals/target.ts` | debug metadata parse, observed model/config 수집 | 원문 prompt 저장 금지 |
| `evals/schema.ts` | diagnostic suite mode | 기존 suite default 유지 |
| `evals/evaluate.ts` | diagnostics, taxonomy, aggregate | H30 수식 불변 |
| `evals/atif.ts` | additive final metrics | ATIF v1.7 형태 유지 |
| `evals/cli.ts` | preflight/manifest/diagnostic exit semantics, character-set 교차 실행 | 비밀값 제외 |
| `evals/cases/character-naturalness-baseline.json` | 공통 8개 × 12 exchange suite | 신규 |
| `evals/*.test.ts` | schema/metric/manifest/호환성 회귀 | 신규·수정 |
| `package.json` | `eval:naturalness` 명령 | 기존 명령 유지 |
| `evals/README.md` | 실행·artifact·provisional 의미 | 동기화 |
| `docs/evals/naturalness-human-review-guide.md` | 사람 평가 guide | 신규 |
| `evals/calibration/naturalness-gold.schema.json` | label 계약 | 신규 |
| `docs/reports/character-chat-p0-baseline-*.md` | 실제 baseline 결과 | 모델 실행 후 신규 |

DB migration, Admin Persona write, service-backend history window 변경은 이 표에 없다.

## 9. 검증 계획

### 무료 검증

```bash
npm run eval:validate
npm run typecheck:eval
npm run test:eval
npm run lint
npm run build
git diff --check
```

추가 회귀 테스트:

- 기존 `long-conversation.json`을 수정 없이 읽고 기존 aggregate fixture 결과가 동일함
- diagnostic suite가 H30 certification을 절대 획득하지 못함
- 기존 질문/near-duplicate check와 새 aggregate 값이 동일 원자료를 사용함
- invalid turn evidence와 unknown taxonomy code를 reject
- hash/count 외 Persona·Memory 원문이 debug metadata와 manifest에 없음
- debug header가 없는 일반/streaming 응답 bytes 불변
- candidate/simulator/judge 동일 모델을 certification으로 오인하지 않음

### 비용이 드는 검증

```bash
# 연결과 artifact만 확인
EVAL_CHARACTER_SET_PATH=/absolute/path/to/character-set.json \
  npm run eval:naturalness -- --profile smoke --cases bare-opening-mutuality

# 1-run fixture 확인
EVAL_CHARACTER_SET_PATH=/absolute/path/to/character-set.json \
  npm run eval:naturalness -- --profile standard

# P0 baseline
EVAL_CHARACTER_SET_PATH=/absolute/path/to/character-set.json \
  npm run eval:naturalness -- --profile confidence
npm run eval:confidence
```

실행 명령에는 실제 key를 shell history나 문서에 직접 쓰지 않는다. 결과 경로는 기존 ignored
`evals/results/<timestamp>/`를 사용한다.

## 10. 구현 순서와 Commit 경계

현재 dirty worktree의 `src/chat/system-prompt.ts`, `src/chat/system-prompt.test.ts`,
`docs/dogeon-persona-improvement-2026-08-31.md`는 사용자 작업으로 간주해 보존한다. P0 구현이
같은 파일을 필요로 하지 않으면 건드리지 않는다. 충돌이 생기면 구현 전에 중단해 범위를
확인한다.

권장 commit 단위:

1. `feat: 캐릭터 챗 기준선 실행 식별자와 자연스러움 진단 추가`
   - debug fingerprint, manifest, additive diagnostics, 회귀 테스트
2. `test: 전체 캐릭터 공통 자연스러움 진단 시나리오 추가`
   - diagnostic mode, runtime character-set, 8개 scenario, coverage 회귀 테스트
3. `docs: 사람 평가 기준과 P0 기준선 결과 기록`
   - annotation guide, calibration 계약, 실제 실행 report

실제 baseline artifact는 대용량·환경 의존 기록이므로 git에 넣지 않는다. 재현에 필요한 manifest와
요약 report만 commit한다.

## 11. 위험과 대응

| 위험 | 영향 | 대응 |
| --- | --- | --- |
| 활성 캐릭터 누락 또는 stale character-set | 일부 결과를 전체 개선으로 오판 | expected count·snapshot 시각·cell coverage hard stop |
| model ID만 같고 backend revision이 다름 | 비교 불가능 | observed response model, endpoint label, prompt/git/suite hash 기록 |
| simulator가 정답을 누설 | recall 점수 부풀림 | leakage guard와 scripted anchor 검사 |
| judge가 유창함을 자연스러움으로 오인 | false pass | turn evidence, blind human gold, false-pass 보고 |
| 한국어 regex 오탐 | 잘못된 hard gate | descriptive metric으로만 사용, 의미 평가는 사람/judge |
| production 대화 PII 반입 | privacy 위반 | synthetic 우선, 별도 데이터 정책 승인 전 사용 금지 |
| P0 관측 코드가 reply를 바꿈 | baseline 오염 | content-free debug only, debug off byte-equivalence test |
| 새 suite가 H30 의미를 흐림 | release 오판 | explicit diagnostic mode, certification 항상 false |
| 3-run 비용과 시간 | 실행 중단·부분 결과 | smoke → 1-run → confidence 순서, partial은 baseline으로 승격 금지 |

## 12. 결정 기록

### 확정

- P0는 평가·관측 baseline이며 답변 개선 로직을 포함하지 않는다.
- 기존 H30 owner와 production logger를 확장하고 parallel 구현을 만들지 않는다.
- 새 자연스러움 지표는 사람 보정 전 diagnostic-only다.
- naturalness suite는 H30과 명시적으로 분리한다.
- production transcript는 기본 gold data가 아니다.
- Persona/canon 원문 대신 content-free fingerprint를 artifact에 기록한다.
- 개선의 소유자는 공통 채팅 엔진·Persona/Memory 계약·평가 체계이며 운영 캐릭터는 runtime data다.
- 한 캐릭터 결과만으로 전체 개선을 주장하지 않는다.
- 2026-09-03 P0-R1은 사용자 1인의 기존 22개 사후검수만 개선 입력으로 삼는다.
- 공통 응답 정책은 직전 발화 우선, 근거 없는 현재 활동 억제, Persona·게시물 소재 과사용 억제,
  질문·상담 모드 억제, 일상 한국어 우선, Persona별 말투 허용을 원칙으로 한다.
- 위 정책은 캐릭터별 분기 없이 `assembleSystemPrompt`의 공통 stable prompt에 둔다.
- 추가 blind reviewer는 보류하고, 기존 seed를 gold나 calibrated 결과로 부르지 않는다.

### P0 구현 시 확인할 외부 조건

- 실제 candidate/simulator/judge endpoint와 model ID
- 활성 캐릭터 전체의 effective UUID와 Persona snapshot read 권한
- 최소 2명의 human reviewer 확보 여부(현재 사용자 결정으로 보류)

### P1로 미룬 결정

- dynamic context와 user text의 최종 순서
- Persona block channel schema
- history window 크기와 service-backend offset 계약
- retrieval relevance threshold와 hybrid search
- Bond와 Korean register 분리 방식
- Character World State 정본과 API
- Memory lifecycle DB schema

P0 보고서의 증거 없이 위 값을 먼저 확정하지 않는다.
