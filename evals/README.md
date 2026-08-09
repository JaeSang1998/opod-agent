# OPOD long-conversation evals

## 빠른 시작

```bash
# 모델 호출 없이 fixture/schema만 검증
npm run eval:validate

# Harbor v0.20.0 task contract 검증(최초 실행 시 uv가 pinned package를 받음)
npm run eval:harbor:validate

# 연결 확인용: 2 scenario × 6 exchanges. H30 인증 결과는 아님
npm run eval:smoke

# H30: 8 scenario × 24 exchanges × 2 judge replicas
npm run eval:long

# release confidence: H30 전체를 scenario당 3회
npm run eval:confidence
```

`eval:validate`와 `test:eval*`에서 쓰는 fixture/test double은 schema와 집계기의 false-pass 방지용일
뿐 대화 품질 실행으로 세지 않는다. 품질 근거는 실제 candidate, simulator, judge endpoint를 호출해
생성된 `eval:long`/`eval:confidence` trajectory artifact뿐이다.

`eval:smoke|long|confidence`는 `.env`를 읽는다. Candidate는 기존 `LLM_*`/`EMBEDDING_*` 설정을
사용한다. simulator와 judge는 `EVAL_SIMULATOR_*`, `EVAL_JUDGE_*`로 분리하는 것을 권장한다. 값이
없으면 judge, 그 다음 candidate 설정으로 fallback하므로 로컬 연결 확인은 한 endpoint로도 가능하지만
동일 모델 self-judge 결과는 release 근거로 삼지 않는다.

기본 target은 production Hono app을 in-process로 실행하고 Memory Consolidation이 끝날 때까지 매 turn
기다린다. 배포 환경을 평가하려면 다음처럼 지정한다.

```bash
EVAL_TARGET_URL=https://agent.example.com/ \
EVAL_TARGET_MODEL=candidate-model \
EVAL_REMOTE_SETTLE_MS=2500 \
npm run eval:long
```

주요 옵션은 CLI 뒤에 전달한다.

```bash
npm run eval:long -- --cases correction-stale-memory,window-compaction-resume
npm run eval:long -- --runs 3 --concurrency 2 --seed 2718
npm run eval:long -- --skip-judge --output /tmp/opod-eval-diagnostics
```

`--skip-judge`는 wiring/결정론 진단용이며 H30을 인증하지 않는다. 모든 run은 고유 user/session/turn ID를
사용한다. simulator는 대화가 심하게 무너지면 repair 뒤 exit할 수 있으며, 조기 exit는 H30 completion
실패다. `eval:smoke`의 exit code는 quality rubric이 아니라 simulator→candidate→judge 연결과 완주만
판정한다.

## Artifacts

기본 출력은 ignored 경로인 `evals/results/<timestamp>/`에 저장된다.

```text
suite-report.json                 # suite aggregate + 모든 trajectory 결과
harbor-reward.json                # 숫자 값만 갖는 Harbor reward payload
trajectory.json                   # 최저 점수 run의 ATIF v1.7 (RewardKit용)
trajectories/<run-id>/result.json
trajectories/<run-id>/trajectory.atif.json
```

`suite-report.json`은 scenario별 run 수, mean/median, min/max/range, sample SD, pass rate와 mixed-pass를
`scenarioStats`에 기록한다. confidence run에서는 scenario별 pass rate가 전체 기준(현재 0.80)보다 낮거나
score range가 0.10을 넘으면 `unstableScenarioIds`에 포함하고 release PASS를 막는다. Harbor reward에도
`stability_passed`, `unstable_scenario_rate`, `maximum_scenario_score_range`를 숫자로 전달한다.

Harbor wrapper는 [`harbor/opod-h30`](harbor/opod-h30)을 사용한다. 먼저 repo root에서 평가 image를
만든 뒤 nop agent로 verifier를 실행한다.

```bash
docker build -f docker/Dockerfile.eval -t opod-agent-eval:local .
uv tool install "harbor==0.20.0"
harbor run -p evals/harbor/opod-h30 -a nop --env-file .env
```

`.env`의 `LLM_BASE_URL`과 `LLM_MODEL`은 필수다. `LLM_API_KEY`는 key가 필요 없는 로컬 endpoint라면
비워 둘 수 있다. `EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY`를 지정하면 chat과 embedding endpoint를
분리하고, 생략하면 기존 `LLM_*` endpoint로 fallback한다. `EVAL_SIMULATOR_*`와 `EVAL_JUDGE_*`도
선택 사항이다. 생략하거나 빈 값이면 runner의 role fallback이 동작하므로 단일 endpoint 연결 확인이
가능하지만, 서로 다른 모델을 쓰지 않은 결과는 H30 release 인증 대상이 아니다.

이 task는 custom Harbor agent가 아니라 **verifier-driven container wrapper**다. `nop` agent는 아무
artifact도 만들지 않고 `AgentContext`에 OPOD rollout을 기록하지 않는다. Harbor는 container/trial/reward
orchestration을 담당하고, OPOD 고유 대화 semantics와 rollout 생성은 verifier의 repository runner가
담당한다. `suite-report.json`, 개별 run 결과, ATIF `trajectory.json`, runner exit code는
`/logs/verifier/opod-eval/`에, 다차원 reward는 `/logs/verifier/reward.json`에 남아 Harbor의 verifier
logs로 수집된다.

PR workflow는 fixture, 27개 harness 회귀 테스트, pinned Harbor task 계약만 검증한다. 실제 모델을
호출하는 workflow_dispatch의 기본 profile은 scenario당 3회인 `confidence`다. 현재 threshold는 human
gold transcript calibration 전의 `H30-provisional` 기준이다.
