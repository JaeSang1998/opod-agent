# H30: 30분 상당 장기 대화 평가 기준

## 목적

“이 Character와 30분 정도 자연스럽게 대화할 수 있다”를 한두 개 prompt의 인상평이 아니라 반복
가능한 capacity/regression gate로 바꾼다. H30은 실제로 30분을 sleep하는 부하 테스트도, 실제 사용자의
30분 retention을 증명하는 실험도 아니다. OPOD의 짧은 DM 형식에서 약 30분에 해당하는 대화량과 장기
의존성을 가속 실행하고, 그 horizon 동안 품질을 유지할 수 있는지 평가한다.

## 운영적 정의

H30 trajectory 한 개는 다음 조건을 만족한다.

- 최소 24회의 user → Character 교환, 즉 48개의 conversation message
- 사람의 메시지 작성·읽기·생각 시간을 교환당 75초로 잡은 30분 상당 horizon. 이 값은 v1의 명시적
  가정이며 실제 사용자 transcript의 turn/time 분포로 재보정한다.
- opening, deepening, interruption/shift, delayed callback/closure의 네 국면
- 최초 공개 뒤 최소 10 user turn 이상 떨어진 callback 또는 recall
- 사실 정정, 주제 중단 후 복귀, 감정 강도 변화 중 둘 이상
- 적어도 한 scenario에서 최근 history를 잘라 nonzero `X-Opod-History-Offset` 사용
- 모든 응답과 채점 근거, latency, token usage, tool event를 trajectory artifact로 보존
- adaptive user simulator가 `continue`, `repair`, `exit`를 선택한다. 심각하거나 반복된 대화 실패로
  `exit`하면 24회 전에 끝나므로 completion hard gate를 통과하지 못한다.

실제 wall-clock 30분 soak는 별도 운영 프로필이다. PR에서는 schema/judge/ATIF/Harbor 계약만 무료로
검증하고, 모델 비용이 드는 가속 H30은 수동 workflow로 실행한다. 시간 SLO와 대화 품질 점수는 섞지
않고 별도 축으로 보고한다.

## 합격 기준

먼저 deterministic hard gate를 적용한다.

- 빈 응답, unrecovered HTTP 오류, 미완료 trajectory가 없다.
- 다른 정체나 AI/model/tool/API/system-prompt plumbing을 사용자에게 노출하지 않는다.
- Persona와 canon을 파괴하지 않는다.
- 고정 probe의 정답을 틀리거나 명시적으로 정정된 옛 사실을 되살리지 않는다.
- simulator가 protected answer를 probe 직전 retained history에 다시 흘리지 않는다.
- 각 trajectory는 고유 user/session/turn ID를 사용한다. 실제 cross-session 격리는 별도 integration
  trajectory가 검증한다.

통과한 trajectory는 다음 식으로 점수화한다.

```text
D = 가중 deterministic assertion 통과율
J = 0.7 × 공통 judge rubric + 0.3 × scenario 전용 rubric
Trajectory = 0                         (critical gate 또는 runtime/judge 실패)
Trajectory = 0.4 × D + 0.6 × J         (그 외)

Suite = 0.7 × mean(scenario별 median) + 0.3 × p10(전체 trajectory)
```

Critical이 아닌 deterministic 검사들은 개별 hard gate가 아니라 `D`에 반영되며, deterministic 묶음은
0.80 이상이어야 한다.

공통 judge rubric은 fixture에 고정한 character persona/canon snapshot, 장기 일관성, 자연스러운 전개,
감정 조율, 관련성/기억 절제, plain-text DM 형식을 1–5점으로 평가한다. 모든 criterion ID는 정확히 한
번만 나와야 하고 유효한 turn 번호와 비어 있지 않은 증거가 필요하다. 첫 1/4과 마지막 1/4의 품질
차이도 별도로 평가하며 마지막 구간이 0.5/5보다 더 하락하면 실패한다.

release gate는 다음과 같다.

- 모든 8개 scenario를 전체 24 turn으로 실행하고 judge를 사용한 run만 certification 대상
- Candidate, user simulator, judge는 서로 다른 model ID를 사용하고 judge replica를 2회 이상 실행
- scenario별 median의 평균 ≥ 0.80
- 전체 trajectory p10 ≥ 0.70
- trajectory pass rate ≥ 0.80
- confidence에서 각 scenario의 pass rate ≥ 0.80
- confidence에서 각 scenario의 3-run score range ≤ 0.10
- critical failure 0건
- standard는 scenario당 1회, confidence/release는 scenario당 3회 이상

LLM judge의 critical 판정은 standard에서 2회 반복 호출 중 같은 enum failure code가 replica별 한 표씩
2표 나와야 확정된다. 한 replica가 같은 code를 여러 번 보고해도 한 표다. 결정론 hard gate는 judge
합의 없이 즉시 적용한다. judge 호출/계약이 실패한 run은 점수와 Harbor primary reward가 0이다.

fixture와 test double로 실행하는 `test:eval*`은 이 집계 계약 자체를 검증하는 회귀 테스트이며 H30 품질
증거가 아니다. release 판단에는 실제 endpoint가 만든 raw transcript와 judge artifact만 사용한다.

현재 숫자 threshold는 v1의 사전 기준이다. blind human review의 good/bad/edge gold transcript에서
judge agreement와 false-pass rate를 측정해 보정하기 전 결과에는 `H30-provisional` 레이블을 사용한다.
코드의 `certificationEligible`은 실행 구조가 H30 계약을 충족했다는 뜻이지, calibration이 끝났다는 뜻은
아니다.

## Scenario suite

[`evals/cases/long-conversation.json`](../evals/cases/long-conversation.json)에 다음 8개 hybrid
trajectory가 있다. exact anchor 사이를 user simulator가 현재 대화에 맞춰 채우며, delayed-recall
구간은 leakage guard로 answer lexeme 재노출을 금지한다.

| Scenario | 핵심 capability |
| --- | --- |
| `rapport-topic-weave` | 네 주제 사이의 라포와 15턴 지연 callback |
| `correction-stale-memory` | Nova/Max 및 금→목 정정, stale belief 억제 |
| `window-compaction-resume` | 8-message window, absolute offset, Summary/Memory 연속성 |
| `low-energy-mutuality` | 짧은 user 응답에서 질문 공세 없이 상호성 유지 |
| `emotional-arc-advice-boundary` | 원치 않는 조언 보류, 후반 요청 뒤 도움 |
| `persona-canon-pressure` | AI/prompt/canon 압박 속 Persona 유지와 감정 전환 |
| `interruption-return` | 세 번의 중단 뒤 알레르기·조리 제약을 보존한 복귀 |
| `ambiguity-repair` | 동명이인 관계 clarification과 정정된 관계 회상 |

실제 weather/web 도구, cross-user/session isolation, retry/stream interruption, async worker backlog는
외부 상태와 fault injection이 필요하므로 core H30과 분리한 integration suite로 확장한다. core suite는
대화 품질 회귀가 외부 네트워크 flake에 묻히지 않도록 기본적으로 도구를 끈다.

## 실행 모델

```text
scripted anchors + LLM user simulator
                │
                ▼
      POST /v1/chat/completions
      (실제 OPOD headers/API seam)
                │
                ▼
     raw transcript + tool events
          ┌─────┴────────┐
          ▼              ▼
 deterministic gates   2× LLM judge
          └─────┬────────┘
                ▼
       JSON report + ATIF v1.7
                ▼
        Harbor reward.json
```

기본 in-process target은 `buildContainer`/`createApp`으로 production 경로를 조립한다. DB 없는 실행에서
`UnavailableLlmLogStore`가 모델 호출을 막지 않도록 raw `OpenAICompatProvider`를 명시 주입하고,
`StubJobQueue`의 새 job을 같은 production `ConsolidationService`로 매 turn 처리한다. batched mode에서는
stale Summary로 생긴 겹치는 prefix job을 최신 summary job 하나로 합쳐 `turnsCovered` 과계를 막는다.

`EVAL_TARGET_URL`을 지정하면 배포된 Agent를 HTTP로 평가한다. 이때 Memory 반영은 실제 Postgres worker
속도에 좌우되므로 고정 sleep보다 job quiescence 관찰이 바람직하다. 현재 runner는 배포 상태 endpoint가
없어 `EVAL_REMOTE_SETTLE_MS`만 제공하며, production certification에서는 worker/DB telemetry로 보강해야
한다.

Harbor task는 custom agent가 아니라 `nop` + shared verifier 기반 container wrapper다. rollout과 LLM
judge는 verifier 안의 동일 runner가 만들며 `/logs/verifier/opod-eval`에 ATIF/보고서를, 
`/logs/verifier/reward.json`에 숫자 reward를 남긴다. Harbor의 역할과 버전별 주의점은
[`docs/research/harbor-long-conversation-eval.md`](research/harbor-long-conversation-eval.md)에 근거와
함께 정리되어 있다.
