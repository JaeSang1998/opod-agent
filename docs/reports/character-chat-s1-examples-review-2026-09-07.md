# S1 후속 — examples 원문 검토와 비교 입력

- 조사일: 2026-09-07
- 상태: examples 조사·A/B/C 입력·모델 경로 연결과 첫 실제 모델 smoke 12회 완료. 사용자 원문 검수 대기, 제품 정책·개선 효과 미확정
- 근거: [S1 snapshot과 승인된 혼합 분리](character-chat-s1-source-audit-2026-09-07.md)
- Source hash: `819922db0f97eb333c896ce8dae48f7d3d953475da8e860a0de39372120fdb0f`
- 범위: 기존 승인 snapshot 재사용, DB 모델 설정 읽기 전용 확인, 승인된 모델 호출 12회. DB 쓰기·원문 재작성 없음

## 판단

예시에는 캐릭터의 말투·칭찬 수용·취향·거절 방식을 보여주는 내용과 현재 상태·공유 기억을
구체화하는 내용이 함께 있다. 따라서 예시 전부를 나쁜 데이터로 판정하거나 바로 지우는 것은
근거가 부족하다. 권장하는 다음 검증은 **같은 혼합 분리 입력에서 예시 유지와 미주입을 비교하는
제거 실험**이다. 제품의 기본 정책은 유지하고, 비교 후보에서만 네 source ID의 injection을 바꾼다.

원문을 먼저 윤문하거나 좋아 보이는 문답만 고르면 내용 수정과 선택 효과가 섞인다. `start_only`는
첫 응답의 잘못된 현재 상태·인사 표현 문제를 해결하지 않는다. `retrieved`로 옮기는 것만으로도
충분하지 않다. 현재 활동을 묻는 질문이 현재 활동을 지어내는 예시와 가장 잘 매칭될 수 있기
때문이다. 예시 선택을 도입한다면 질문 유사도 외에 관계 단계·사건 근거·선행 문맥을 따로 다뤄야
하지만, 첫 비교 이전에 그런 선택기를 만들지는 않는다.

## 원문에서 확인한 사실과 한계

| 항목 | 수 | 해석 |
| --- | ---: | --- |
| 문답 수 | 54 | C1 5 / C2 5 / C3 27 / C4 17 |
| 구체적인 현재·최근 상태에 맥락이 필요한 예 | 13 | 당일 사진·착장, 작업 상태, 수행 원인, 답장 지연 사유 등. 실제 발화의 거짓 판정은 아님 |
| 기존 사용자 실패 문장과 정확히 같은 예 | 1 | human-006. 재등장 경로의 후보이며 인과관계 증명은 아님 |
| 예시 안에 없는 구체적인 공유 기억 주장 | 1 | 사용자가 제공한 결과에 이전 대화의 세부 내용을 덧붙임 |
| 대표 소재로의 전환 검토 | 4 | 관련 질문에 정체성을 설명하는 정상 응답과 구분 |
| 앞선 이력에 의존하는 인정·표현 | 3 | 사용자가 전제한 사실에 대한 수용도 포함. 모두 허위 기억으로 분류하지 않음 |
| 인접한 예시의 선행 문맥이 필요한 문답 | 1 | 따로 선택하면 지시 대상이 사라질 수 있음 |
| 요청하지 않은 자기 경험으로의 전환 검토 | 1 | 공감에 적절한 자기 노출인지는 실제 대화에서 판단 |

신호는 중복된다. 하나 이상 주석을 붙인 문답은 22개이며, 이는 22개 실패나 나머지 32개 통과를
뜻하지 않는다. 문답 구간은 조사 단위다. 특히 이어지는 예시를 하나의 대화로 읽을 여지가 있어
각 구간을 독립 실행 가능한 few-shot으로 확정하지 않았다. 모든 문답은 원문 byte 범위와 hash로
추적되며 네 블록으로 정확히 재조립된다.

추가로 확인한 영향 경로는 다음과 같다.

- C1의 직업을 이유로 회피하는 표현은 examples 외의 `boundaries`에도 있다. 예시를 제외해도
  같은 표현이 남을 수 있으므로 무효과를 예시 가설의 완전한 기각으로 해석하지 않는다.
- `voice`에도 짧은 예문과 현재 맥락에 의존하는 표현이 있다. 이번 C 조건은 제목으로 고른 네
  원본 block ID의 주입만 바꾸므로 모든 예시형 표현을 제거한 조건이 아니다.
- 정적 생애·취향을 직접 묻는 질문에 관련 canon을 말하는 것은 정상 기능이다. 이런 답변을
  현재 상태 날조와 함께 제거 대상으로 세지 않는다.
- C2에는 관계 단계 표제가 있다. 관계에 맞는 반말과 혼용을 자동 실패로 세지 않는다.
- 거절·개인정보·통증 대응 등의 원칙은 별도 behavior/boundaries에도 남는다. 다만 원칙의
  존재가 예시 제외 후 말투·경계의 품질까지 보장하지 않으므로 실제 비교에서 함께 검수한다.

## 준비한 세 조건

| 조건 | 입력 | examples | 확인할 차이 |
| --- | --- | --- | --- |
| A | 원문 45개 블록 | 기존 주입 | 현재 기준선 |
| B | 승인된 혼합 분리 59개 블록 | 기존 주입 | A↔B: 혼합 source 분리의 국소 효과 |
| C | B와 동일한 59개 블록 | 네 ID만 `example / never_prompt` | B↔C: 예시 블록 노출의 국소 효과 |

C도 예시 원문을 삭제하지 않는다. B와 비교하면 정책 필드 네 곳만 바뀌고 다른 55개 블록,
캐릭터 기본 정보, canon 79개, 원문·순서를 보존한다. 기존 A/B 파일과 DB는 그대로다.
준비한 C는 검토용 후보이며 제품의 기본 정책을 승인하거나 적용한 기록이 아니다.

A↔C만 비교해 두 변경의 효과를 합쳐 주장하지 않는다. 이 세 조건은 전체 Persona mapping이나
예시·routing의 상호작용을 모두 추정하는 2×2 실험도 아니다. 33개 원본 블록의 route 후보는
계속 적용하지 않는다. 이미 정한 국소 범위를 명시하면 전체 mapping 결정을 기다리지 않고
작은 첫 모델 비교를 준비할 수 있다.

## 준비 검사

기존 `ChatService.prepare`, `routePersona`, `StubPersonaStore`를 사용했다. 별도 채팅 엔진이나
제품 source 변경 없이, 캐릭터 4명 × 상황 8개 × 조건 3개 = **96건**을 검사했다.

- 상황: 중립 인사, 현재 활동, 근거 없는 회상, visible history가 있는 회상, 칭찬, 요청한 위로,
  개인정보 경계, 개인적 의견. source를 보고 만든 진단 사례이며 holdout으로 부르지 않는다.
- 시각 고정, tools 없음, Bond 미추적, 현재 상태·사용자 Memory fixture 없음, optional lore
  선택 0으로 통일했다. 실제 relevance selector나 지속 Memory 회수 품질을 검사하지 않는다.
- A/B는 예시 source가 stable prompt에 남고 C는 제외되며, C의 예시가 selector 후보에 들어가지
  않는다. 각 캐릭터·조건의 stable hash는 여덟 상황에서 유지된다.
- C는 네 예시 정책만 다르고, 다른 블록·canon·기본 정보와 기존 snapshot/분리 입력은 불변이다.
- chat 호출 0회, embedding 호출 0회. `qualityPassed`와 `certificationEligible`은 `false`다.
- 54개 구간의 원문 재조립, hash, gitignore와 0600 파일 권한을 확인했다.

이 준비 단계에서는 로컬 입력만 조사했다. 이후 사용자 진행 요청으로 아래 모델 경로 연결과
정식 회귀 검증을 추가했다. 위의 chat 0회와 아래의 합성 completion 96회를 구분한다.

## 모델 경로 연결과 검증

- `evals/target.ts`가 기존 `buildContainer`의 Persona/selector override와 고정 clock을 연결한다.
  모델별 응답도 실제 HTTP route → ChatService → OpenAI-compatible provider를 통과한다.
  제품의 기본 Store·시각·재시도 동작은 유지하고 격리 평가만 override를 사용한다.
- `eval:persona-comparison`은 입력 file hash를 검증하고 각 prefix/조건마다 새 target을 만든다.
  동일 clock·canon·hidden state·모델 설정을 검사하며 생성 답변을 다음 조건에 전달하지 않는다.
  전체 호출량 사전 검사, 클라이언트 재시도 0, 실패·잘린 응답에서 즉시 중단, 응답 우선 저장을 제공한다.
- 기존 review 구현을 확장해 같은 캐릭터의 A↔B, B↔C를 각각 조건을 가려 제공한다. 원문·이름은
  유지하고 `both_bad`도 선택할 수 있다. 사용자 1인 검수이며 기존 2인 agreement 집계는 사용하지 않는다.
  자동 judge를 호출하지 않고 `not-judged`로 보존한다. 1인 결과의 자동 품질 판정은 아직 없다.
- 실제 source 4명 × 8상황 × 3조건을 CLI로 실행해 합성 응답 **96건**, 외부 모델·embedding **0회**를
  확인했다. 두 패킷 각각 동일 캐릭터·prefix 32쌍이다. 기존 snapshot과 A/B/C hash는 그대로다.
- 별도 12회 smoke manifest도 CLI preflight를 통과했다. 두 실행의 합성 응답 108건·검수 72쌍을
  독립 대조해 캐릭터/상황/반복·prefix·응답 보존과 hash·권한·gitignore를 포함한 35개 검사를 통과했다.
- 실제 SDK 통신 경로는 로컬 HTTP 모의 서버로 검증했다. 429는 재시도 없이 중단하고 출력 토큰
  부족 응답은 보존한 뒤 실패한다. 이 통신 테스트를 실제 모델 실행으로 세지 않는다.
- 새 실행 결과: 제품 `test:coverage` **280 통과 / Postgres 통합 14 skip**, 평가
  `test:eval:coverage` **78 통과**, 두 coverage gate 통과. runtime/eval typecheck, lint,
  production build, root workspace dead-code 통과. 웹 의존성 미설치로 전체 dead-code 검사는
  통과했다고 주장하지 않으며 웹 검증은 재실행하지 않았다.
- 기존 `eval:validate`의 H30 8개 시나리오와 `git diff --check`도 통과했다.

## 첫 모델 실행 계약과 경계

사용자가 모델 설정이 DB에 있다고 알려준 뒤 `opod.admin_settings`의 chat 설정만 읽기 전용으로
확인했다. 기존 provider의 `agent` 우선 규칙에 따라 OpenRouter의 `xiaomi/mimo-v2.5-pro`가 선택된다.
`agent.llmApiKey`는 존재 여부만 확인했고 인증값을 출력·파일 저장하지 않았다. Persona snapshot은
재조회하지 않았다. 키 존재는 실제 인증 성공을 뜻하지 않는다.

첫 실행안은 인사 1상황 × 4명 × 3조건 × 1반복 = **12회**다. `temperature=1`, `top_p=0.95`,
`max_tokens=8192`, 클라이언트 재시도 0회, embedding/tools 없음으로 기존 평가 요청 기본값을
고정한다. source/case의 hash가 있는 별도 smoke manifest와 인증값 없는 실행 계약을 만들었다.
실제 요청 payload를 로컬 합성 provider로 조립한 추가 12건 검사에서 같은 설정을 확인했다.

요청 messages JSON은 합계 170,282 UTF-8 bytes다. byte당 1 token과 요청당 framing 512 token을
가정한 보수적 입력 추산 176,426 token, 전체 최대 출력 98,304 token을 사용했다.
확인 시점 [OpenRouter 제공사별 가격](https://openrouter.ai/api/v1/models/xiaomi/mimo-v2.5-pro/endpoints)의
최대 입력 $0.522/백만 token, 출력 $1.50/백만 token을 각각 적용하면 약 **$0.24**다.
실제 tokenizer 측정이나 강제 달러 상한은 아니며 가격 변동·세금·크레딧 구매 수수료는 제외한다.

OpenRouter의 기존 자동 제공사 선택과 reasoning 기본값은 유지하는 실행안이다. 모델명이 같아도
제공사가 달라질 수 있으므로 이 12회는 연결 확인과 초기 원문 검토다. 본 비교의 인과 해석 전에는
upstream/reasoning 조건을 고정하거나 관측할 계약이 필요하다. 288회 반복 비교는 자동으로 이어 실행하지 않는다.
이 범위를 제시한 뒤 사용자가 승인했고 아래 12회 실행을 완료했다. 최초 실행안 JSON의
`prepared-awaiting-paid-run-approval`은 작성 당시 상태이며, 후속 승인 기록을 별도 파일로 보존했다.

## 실제 모델 smoke 결과

2026-09-07 17:40:42 KST에 `eval:persona-comparison -- run` 경로가 exit 0으로 완료됐다.
DB의 endpoint·모델이 승인 계약과 동일한지 확인하고 API 키를 프로세스 메모리에서만 전달했다.
재호출이나 반복 비교 확대는 하지 않았다.

| 항목 | 관측 결과 |
| --- | --- |
| 모델 생성 | 12/12 완료, 고유 response ID 12개, 모든 finish reason `stop` |
| 요청 모델 / generation 정식 ID | `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5-pro-20260422` |
| 입력 / 출력 토큰 | 49,584 / 1,537, 합계 51,121 |
| 공급자 보고 청구액 | **$0.020053869**. 최초 약 $0.24 추산과 구분 |
| 응답 시간 | 최소 5.39초 / 중앙값 7.54초 / 최대 22.96초 |
| 원문 검수 패킷 | 2개, 각각 동일 캐릭터·prefix 4쌍. 원문 유지, 조건·모델 가림 |
| 독립 검증 | 32개 검사 통과. 실제 prompt debug와 preflight의 완전 일치, source/case hash 불변, 권한·gitignore 확인 |
| 품질 상태 | 사용자 미검수, `qualityPassed=false`, `certificationEligible=false` |

청구액과 제공사는 저장된 12개 response ID의
[OpenRouter generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation)를
읽기 전용 GET 12회로 확인했다. 이 조회는 응답을 새로 생성하지 않는다. generation의 날짜가 붙은
모델 ID는 공개 Models API의 `canonical_slug`와 12개 모두 일치하며, 응답의 별칭을 다른 모델로
판정하거나 artifact 안에서 덮어쓰지 않았다. API 키가 결과 파일에 없는 것도 확인했다.

실제 제공사는 Xiaomi 7회, GMICloud 2회, DigitalOcean·DeepInfra·Novita 각 1회였다.
reasoning token 보고값은 두 generation에서 111/112이고 나머지는 0이다. 보고값 0만으로
추론이 없었다고 단정하지 않는다. 따라서 같은 모델 문자열만 고정한 상태로는 제공사와 추론
처리 차이를 배제할 수 없다는 제한이 실제 실행에서도 확인됐다.

이번 입력은 인사 한 가지이고 셀마다 1회뿐이며 답변도 7~27자로 짧다. 현재 상태·허위 회상·경계·
캐릭터성 유지 가설을 이 결과만으로 판단할 수 없다. 우선 아래 패킷에서 첫 응답을 사용자가
검수한다. 본 비교의 다음 준비는 **제공사/reasoning 계약 고정과 진단 상황별 반복**이며,
이 smoke를 근거로 Persona 정책을 채택하거나 288회를 자동 실행하지 않는다.

B↔C에서 불필요한 현재 상태·과거 주장이 줄어도 캐릭터성·경계·근거 있는 응답이 약해지면
   C를 제품 후보로 채택하지 않는다. 이득이 있으면 미사용 사례로 재검증하고, 무효과라면 같은
   표현이 남은 voice/boundaries/canon 등 근거가 있는 경로를 다음 한 가지 요인으로 검토한다.

## 로컬 artifact

아래 파일은 모두 기존 ignored 디렉터리에만 있으며 원문/ID를 저장소 문서에 옮기지 않는다.

- [문답별 원문 검토](../../evals/results/s1-source-audit-2026-09-07/examples-review.md)
- [54개 구간·검토 신호](../../evals/results/s1-source-audit-2026-09-07/examples-review.json)
- [예시 미주입 후보 계획](../../evals/results/s1-source-audit-2026-09-07/examples-ablation-plan.json)
- [C 조건 입력](../../evals/results/s1-source-audit-2026-09-07/candidate-without-examples.json)
- [8개 고정 상황](../../evals/results/s1-source-audit-2026-09-07/examples-comparison-cases.json)
- [96건 준비 검사](../../evals/results/s1-source-audit-2026-09-07/examples-ablation-preflight.json)
- [모델 경로용 고정 manifest](../../evals/results/s1-source-audit-2026-09-07/comparison-preflight-manifest.json)
- [CLI 합성 응답 96건 결과](../../evals/results/s1-source-audit-2026-09-07/comparison-target-preflight/comparison-report.json)
- [12회 smoke manifest](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-manifest.json)
- [12회 실행안·비용 추산](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-execution-contract.json)
- [12회 CLI smoke 준비 결과](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-preflight/comparison-report.json)
- [artifact 독립 대조](../../evals/results/s1-source-audit-2026-09-07/comparison-artifact-verification.json)
- [12회 사용자 승인 기록](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-run-authorization.json)
- [실제 모델 결과](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-model-run/comparison-report.json)
- [사용자 검수 묶음 1](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-model-run/review-1.md)
- [사용자 검수 묶음 2](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-model-run/review-2.md)
- [실제 청구·제공사 조회](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-model-run/provider-usage-audit.json)
- [실제 모델 artifact 32개 검증](../../evals/results/s1-source-audit-2026-09-07/comparison-smoke-model-run/verification.json)

## Knowledge Delta

- `repo-evidenced`: examples와 기존 실패 문장의 일치, 현재 상태·이력 의존성, 다른 블록에 남는
  표현을 확인했다. 원인 확정이나 제품의 예시 제외 정책으로 승격하지 않는다.
- `owner-found`: 예시 주입도 기존 Router가 소유하며 새로운 예시 전용 routing 계층이 필요하지 않다.
- `repo-evidenced`: 기존 target의 격리 입력, 비교 orchestration, 같은 캐릭터 review를 구현·검증했다.
  사용법과 재시도·원문·1인 검수 경계는 기존 `evals/README.md`에 반영했다. 별도 codebase guide는 만들지 않았다.
- `agent-assumed`: A/B/C는 되돌릴 수 있는 진단 입력으로만 준비했다. 제품 정책은 유지한다.
- `repo/externally-evidenced`: 실제 모델 12회 완료와 5개 제공사의 응답·과금 metadata를 위 결과에
  기록했다. 본 비교의 제공사/reasoning 통제 필요성을 계획 정본에 반영했고, 개선 효과는 승격하지 않았다.
- 계획 정본 11절에 국소 비교와 전체 mapping 완료를 분리했다. 새 codebase guide·개인 Work OS
  규칙은 만들지 않았다. 이번 조사에서 새로운 개인 운영 선호는 확인되지 않았다.
