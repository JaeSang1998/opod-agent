# Harbor를 이용한 OPOD 장기 대화 평가 조사

조사일: 2026-08-02  
범위: Harbor 공식 문서와 `harbor-framework/harbor` 공식 GitHub 저장소만 사용

## 결론

Harbor는 **대화 품질 평가기 자체**라기보다, 격리된 환경에서 agent rollout을 실행하고
`task → trial → reward → trajectory`를 수집·비교하는 평가 harness다. OPOD의 “30분 자연 대화”
평가에는 Harbor를 바깥 orchestration 계층으로 쓰고, 다음 두 부품을 OPOD 쪽에서 추가하는 구성이
가장 작고 명확하다.

1. `BaseAgent`를 구현한 `OpodConversationAgent`: simulated user와 OPOD HTTP API 사이에서 여러 턴을
   진행하고 ATIF `trajectory.json`을 기록한다.
2. task의 `tests/`에서 실행하는 RewardKit verifier: 결정론적 무결성 검사와 trajectory 기반
   LLM-as-a-judge를 함께 실행해 다차원 `reward.json`을 만든다.

Harbor의 native multi-step은 “순차 instruction + 단계별 검증” 기능이다. 자연 대화에서 매 user
turn을 생성하는 simulator는 아니다. 첫 버전은 **한 Harbor task 안에서 custom agent가 전체 대화를
끝까지 진행**하게 하고, multi-step은 이후 checkpoint 평가나 phase별 early-stop이 필요할 때만 쓰는
편이 낫다.

## 조사 기준 버전

- 조사 시점 최신 stable release는 [`v0.20.0`](https://github.com/harbor-framework/harbor/releases/tag/v0.20.0),
  release commit은 `459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc`다.
- 조사한 `main` HEAD는
  [`72bc40b1e58b47a9cc6e0f14c29aced3a9e53767`](https://github.com/harbor-framework/harbor/commit/72bc40b1e58b47a9cc6e0f14c29aced3a9e53767)
  (2026-07-31)이다. 이 문서의 실행 예시는 stable `v0.20.0`을 기준으로 한다.
- Harbor `v0.20.0`은 Python `>=3.12`, Apache-2.0이다
  ([pyproject](https://github.com/harbor-framework/harbor/blob/v0.20.0/pyproject.toml),
  [LICENSE](https://github.com/harbor-framework/harbor/blob/v0.20.0/LICENSE)).
- 같은 tag에 포함된 RewardKit은 `0.1.7`, Python `>=3.12`, Apache-2.0이다
  ([RewardKit pyproject](https://github.com/harbor-framework/harbor/blob/v0.20.0/packages/rewardkit/pyproject.toml)).
- stable task schema 예시는 `1.3`이지만 현재 `main` 문서는 `1.4`다
  ([v0.20.0 task docs](https://github.com/harbor-framework/harbor/blob/v0.20.0/docs/content/docs/tasks/index.mdx),
  [조사 시점 main task docs](https://github.com/harbor-framework/harbor/blob/72bc40b1e58b47a9cc6e0f14c29aced3a9e53767/docs/content/docs/tasks/index.mdx)).
  stable을 쓸 때는 `schema_version = "1.3"`으로 고정하고 main의 예시를 섞지 않는 편이 안전하다.

## Harbor가 제공하는 것

공식 용어는 다음과 같다
([Core Concepts](https://www.harborframework.com/docs/core-concepts)).

| 개념 | 의미 | OPOD 매핑 |
| --- | --- | --- |
| Task | instruction, container environment, verifier/test의 묶음 | 대화 scenario 하나 |
| Dataset | task 모음 | 장기 대화 scenario suite |
| Agent | task를 수행하는 프로그램 | OPOD를 호출하는 conversation runner |
| Environment | agent가 동작하는 container | OPOD 서버와 필요한 DB/worker |
| Trial | agent가 task를 한 번 수행한 rollout | trajectory 한 개 |
| Job | 여러 task/agent/model/attempt의 trial 묶음 | 평가 캠페인 한 번 |

Harbor는 task × agent/model × attempt를 trial들로 전개하고 병렬 실행한다. 따라서 여러 trajectory는
scenario task를 여러 개 두고 `n_attempts`를 늘리는 방식으로 얻을 수 있다. 결과 viewer는 trial,
reward, 비용/토큰, tool call, trajectory, artifact를 탐색하고 job끼리 비교한다
([Run Evals](https://www.harborframework.com/docs/run-jobs/run-evals)).

Harbor가 직접 정의하지 않는 것은 다음과 같다.

- simulated user의 행동과 persona
- “30분 상당”을 turn 수, 실제 wall-clock, 혹은 synthetic time 중 무엇으로 볼지
- 대화 종료 조건과 scenario phase 전이
- 자연스러움·관계 지속성·캐릭터 일관성의 rubric
- SUT용 모델과 judge용 모델의 독립성

이 부분은 custom agent와 task/rubric의 평가 계약으로 명시해야 한다.

## 설치와 기본 CLI

공식 설치법은 `uv tool install harbor` 또는 `pip install harbor`다
([Getting Started](https://www.harborframework.com/docs/getting-started)). 재현 가능한 평가에서는 버전을
고정한다.

```bash
uv tool install "harbor==0.20.0"
harbor --version
harbor --help
harbor run --help

# RewardKit을 독립 실행할 때
uv tool install "harbor-rewardkit==0.1.7"
```

주요 명령은 다음과 같다.

```bash
# task scaffold
harbor init --task "opod/long-chat-casual"

# local task 또는 task directory 실행
harbor run -p evals/harbor/tasks \
  -a evals.harbor.opod_conversation_agent:OpodConversationAgent \
  -m '<sut-provider>/<sut-model>' \
  -k 5 \
  -n 2

# YAML/JSON JobConfig 실행
harbor run -c evals/harbor/job.yaml

# 결과 탐색
harbor view evals/harbor/jobs
```

`-k/--n-attempts`는 task별 반복 수, `-n/--n-concurrent`는 동시 trial 수다. 장기 대화는 provider
rate limit과 DB/session 격리를 고려해 처음에는 동시 실행 수를 낮춰야 한다. custom agent,
environment, verifier는 각각 `module.path:ClassName` import path를 `--agent`, `--env`, `--verifier`에
직접 넘긴다. `--ak`, `--ek`, `--verifier-kwarg`로 constructor 값을 전달할 수 있다
([v0.20.0 CLI source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/cli/jobs.py),
[unified flags changelog](https://github.com/harbor-framework/harbor/blob/v0.20.0/CHANGELOG.md#2026-06-20--unified-agent-environment-and-verifier-flags)).

## Python API

현재 API는 constructor를 직접 호출하지 않고 `await Job.create(config)`를 사용한다. `v0.3.0`에서
이것이 breaking change였고, stable source도 직접 `Job(config)` 호출을 막는다
([v0.3.0 release](https://github.com/harbor-framework/harbor/releases/tag/v0.3.0),
[`Job.create`](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/job.py)). 일부 RL 문서의
옛 `Job(...)` 예시는 그대로 복사하지 않는다.

```python
import asyncio
from pathlib import Path

from harbor.job import Job
from harbor.models.environment_type import EnvironmentType
from harbor.models.job.config import JobConfig
from harbor.models.trial.config import (
    AgentConfig,
    EnvironmentConfig,
    TaskConfig,
    VerifierConfig,
)


async def main() -> None:
    config = JobConfig(
        job_name="opod-long-chat-v1",
        jobs_dir=Path("evals/harbor/jobs"),
        n_attempts=5,
        n_concurrent_trials=2,
        tasks=[TaskConfig(path=Path("evals/harbor/tasks"))],
        agents=[
            AgentConfig(
                import_path=(
                    "evals.harbor.opod_conversation_agent:"
                    "OpodConversationAgent"
                ),
                model_name="<sut-provider>/<sut-model>",
                kwargs={
                    "simulator_model": "<provider>/<simulator-model>",
                    "profile": "accelerated-30m",
                },
            )
        ],
        environment=EnvironmentConfig(type=EnvironmentType.DOCKER),
        verifier=VerifierConfig(
            env={"OPENAI_API_KEY": "${JUDGE_OPENAI_API_KEY}"},
        ),
    )
    job = await Job.create(config)
    result = await job.run()
    for trial in result.trial_results:
        print(trial.trial_name, trial.verifier_result)


asyncio.run(main())
```

`Job.run()`은 in-memory `JobResult`에 `trial_results`를 포함해 반환한다. 디스크의 job-level
`result.json`은 집계 결과 중심이고, 각 trial의 상세 결과는 그 trial의 `result.json`에 저장된다
([Job source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/job.py),
[result models](https://github.com/harbor-framework/harbor/tree/v0.20.0/src/harbor/models)).

## 확장점 작성법

### Custom task

기본 구조와 경로 계약은 다음과 같다
([Task Structure](https://www.harborframework.com/docs/tasks)).

```text
task-name/
├── instruction.md
├── task.toml
├── environment/
│   ├── Dockerfile                  # 또는 prebuilt docker_image
│   └── docker-compose.yaml         # 선택: DB/worker sidecar
├── solution/
│   └── solve.sh                    # 선택: oracle sanity check
└── tests/
    ├── test.sh
    ├── deterministic_checks.py
    └── conversation_quality.toml
```

중요한 container 경로는 `/logs/agent/`, `/logs/verifier/`, `/logs/artifacts/`, `/tests/`,
`/solution/`이다. `tests/test.sh`는 반드시 다음 중 하나를 써야 한다.

- `/logs/verifier/reward.txt`: 단일 숫자
- `/logs/verifier/reward.json`: 숫자 값들로 된 JSON object

둘 다 있으면 stable source는 `reward.json`을 먼저 읽는다
([Verifier source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/verifier/verifier.py)).

OPOD task에는 다음을 넣는 것이 적절하다.

- `instruction.md`: runner가 수행할 공개 scenario와 종료 조건
- `environment/scenario.json`: phase, delayed-recall fact, perturbation schedule 등 구조화된 입력
- `[agent].timeout_sec`: 실제 30분 run이면 최소 2,100~2,400초
- `[verifier].timeout_sec`: judge 호출 횟수에 맞춰 600~900초
- `artifacts`: ATIF, raw transcript, latency/error trace, memory snapshot 등
- `[environment].docker_image`: 가능하면 tag가 아니라 immutable digest

OPOD + DB + worker를 함께 띄워야 하면 local Docker의 `environment/docker-compose.yaml`을 사용할 수
있다. Harbor가 자동 관리하는 agent container service 이름은 `main`이다
([multi-container tutorial](https://www.harborframework.com/docs/tutorials/mcp-server-task)). Compose 지원은
environment provider별 capability이므로 cloud provider로 옮기기 전에 확인해야 한다.

### Custom agent

외부 orchestration형 agent는 `BaseAgent`, container 안에 CLI를 설치하고 실행하는 유형은
`BaseInstalledAgent`를 구현한다. OPOD 대화 runner는 전자가 더 단순하다
([Agents](https://www.harborframework.com/docs/agents),
[`BaseAgent` source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/agents/base.py)).

필수 메서드는 `name`, `version`, `setup`, `run`이다. ATIF를 쓰면 `SUPPORTS_ATIF = True`를 선언한다.
`run` 도중 `AgentContext`에 token/cost를 채우거나, 로그가 host로 동기화된 뒤 호출되는
`populate_context_post_run`에서 채울 수 있다.

```python
import json
import shlex
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class OpodConversationAgent(BaseAgent):
    SUPPORTS_ATIF = True

    def __init__(
        self,
        *args,
        simulator_model: str,
        profile: str = "accelerated-30m",
        **kwargs,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.simulator_model = simulator_model
        self.profile = profile

    @staticmethod
    def name() -> str:
        return "opod-conversation"

    def version(self) -> str:
        return "0.1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        await environment.exec("mkdir -p /opt/opod-eval", user="root")
        await environment.upload_file(
            Path(__file__).with_name("run_conversation.py"),
            "/opt/opod-eval/run_conversation.py",
        )
        await environment.exec(
            "cd /app && "
            "nohup npm start >/logs/agent/opod-server.log 2>&1 & "
            "echo $! >/logs/agent/opod-server.pid"
        )
        ready = await environment.exec(
            "for i in $(seq 1 30); do "
            "curl -fsS http://127.0.0.1:8787/healthz && exit 0; "
            "sleep 2; done; exit 1",
            timeout_sec=70,
        )
        if ready.return_code != 0:
            raise RuntimeError("OPOD server did not become healthy")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        result = await environment.exec(
            command=(
                "python /opt/opod-eval/run_conversation.py "
                f"--instruction {shlex.quote(instruction)} "
                "--scenario /app/scenario.json "
                "--opod-url http://127.0.0.1:8787 "
                f"--sut-model {shlex.quote(self.model_name or '')} "
                f"--simulator-model {shlex.quote(self.simulator_model)} "
                f"--profile {shlex.quote(self.profile)} "
                "--trajectory /logs/agent/trajectory.json "
                "--raw-log /logs/agent/conversation.jsonl "
                "--metrics /logs/agent/run-metrics.json"
            ),
            timeout_sec=2_400,
        )
        if result.return_code != 0:
            raise RuntimeError(result.stderr or result.stdout or "runner failed")

    def populate_context_post_run(self, context: AgentContext) -> None:
        metrics_path = self.logs_dir / "run-metrics.json"
        if not metrics_path.exists():
            return
        metrics = json.loads(metrics_path.read_text())
        context.n_input_tokens = metrics.get("input_tokens")
        context.n_output_tokens = metrics.get("output_tokens")
        context.cost_usd = metrics.get("cost_usd")
        context.metadata = {
            "scenario_id": metrics.get("scenario_id"),
            "seed": metrics.get("seed"),
            "turn_pairs": metrics.get("turn_pairs"),
            "elapsed_sec": metrics.get("elapsed_sec"),
        }
```

실제 runner는 각 turn마다 로그를 append하고 ATIF를 원자적으로 갱신해야 timeout/crash 때도 부분
trajectory가 남는다. OPOD request에는 매 user turn마다 새 `X-Opod-Turn-Id`를 쓰고 같은 logical turn의
retry에서만 재사용해야 한다. `userId`, `characterId`, `sessionId`는 trial UUID에서 파생해 병렬 trial
간 memory가 섞이지 않게 한다.

### Custom environment

기존 Docker/Daytona/Modal 등의 sandbox backend가 부족할 때만 `BaseEnvironment`를 구현한다. task의
`environment/Dockerfile`을 만드는 것과 새로운 Harbor environment provider를 만드는 것은 다른 일이다.
OPOD 첫 통합에는 후자가 필요하지 않다.

새 provider의 최소 contract는 다음과 같다
([`BaseEnvironment` source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/environments/base.py),
[`EnvironmentFactory` source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/environments/factory.py)).

- `type()`과 `_validate_definition()`
- `start(force_build)` / `stop(delete)`
- `upload_file`, `upload_dir`, `download_file`, `download_dir`
- `exec(command, cwd, env, timeout_sec, user) -> ExecResult`
- 지원하는 기능을 정확히 나타내는 `EnvironmentCapabilities`
- 선택: resource capability, network policy switching, compose service operation

사용은 `harbor run ... --env package.module:MyEnvironment --ek key=value`다. 구현하지 않은 network,
GPU, Windows, compose capability를 `True`로 광고하면 안 된다.

### Custom evaluator/verifier

Harbor 용어는 evaluator가 아니라 verifier다. 보통은 custom class보다 task의 `tests/test.sh`가 더
이식성 있고 RewardKit과 바로 연결된다. host-side 접근이나 특수 외부 시스템이 꼭 필요하면
`BaseVerifier`를 상속하고 `verify() -> VerifierResult`를 구현한다
([`BaseVerifier` source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/verifier/base.py),
[`VerifierFactory` source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/verifier/factory.py)).

```python
from harbor.models.verifier.result import VerifierResult
from harbor.verifier.base import BaseVerifier


class ConversationVerifier(BaseVerifier):
    async def verify(self) -> VerifierResult:
        trajectory = self.trial_paths.agent_dir / "trajectory.json"
        score = 1.0 if trajectory.exists() else 0.0
        return VerifierResult(rewards={"trajectory_valid": score})
```

```bash
harbor run ... --verifier evals.harbor.verifier:ConversationVerifier
```

## Multi-turn trajectory 지원

### ATIF v1.7

Harbor의 Agent Trajectory Interchange Format(ATIF)은 user, agent, system message와 tool call,
observation, token/cost, timestamp를 한 JSON에 기록한다. 단일 turn과 extended multi-turn 대화를 모두
지원한다. stable의 current schema는 `ATIF-v1.7`이다
([trajectory docs](https://www.harborframework.com/docs/agents/trajectory-format),
[ATIF RFC](https://github.com/harbor-framework/harbor/blob/v0.20.0/rfcs/0001-trajectory-format.md)).

OPOD trajectory의 권장 형태는 다음과 같다.

```json
{
  "schema_version": "ATIF-v1.7",
  "session_id": "<trial-uuid>",
  "trajectory_id": "<scenario-id>:<seed>",
  "agent": {
    "name": "opod-agent",
    "version": "<git-sha>",
    "model_name": "<provider>/<model>",
    "extra": {
      "persona_version": "<version>",
      "memory_policy_version": "<version>"
    }
  },
  "steps": [
    {
      "step_id": 1,
      "timestamp": "<ISO-8601>",
      "source": "user",
      "message": "...",
      "extra": {"phase": "rapport", "simulated_elapsed_sec": 0}
    },
    {
      "step_id": 2,
      "timestamp": "<ISO-8601>",
      "source": "agent",
      "message": "...",
      "model_name": "<provider>/<model>",
      "metrics": {"prompt_tokens": 0, "completion_tokens": 0},
      "extra": {"latency_ms": 0, "http_status": 200}
    }
  ],
  "extra": {
    "scenario_id": "casual-delayed-recall-v1",
    "seed": 1101,
    "profile": "accelerated-30m"
  }
}
```

`Step.step_id`는 1부터 연속이어야 한다. `source`는 `system | user | agent`다. Harbor Pydantic model로
생성하고 validator로 검증할 수 있다. 긴 대화가 context compaction 등으로 여러 파일이 되면
`continued_trajectory_ref`를 쓸 수 있다. 첫 버전은 한 파일로 유지하는 편이 viewer와 judge 연결이
간단하다.

### Harbor native multi-step

Multi-step task는 같은 environment에서 ordered step들을 순차 실행하고, step마다 instruction,
setup, verifier와 reward를 둘 수 있다. 기본값은 매 step마다 새 conversation이며
`--resume-trajectory`를 켜야 이전 native session에 follow-up instruction을 보낸다. 이 flag는
`SUPPORTS_RESUME` agent에서만 동작하고, 미지원 agent는 시작 전에 실패한다
([Multi-step Tasks](https://www.harborframework.com/docs/tasks/multi-step)).

`agent.load_trajectory`는 `v0.20.0`에서 예약 interface일 뿐 아직 구현되지 않았다
([AgentConfig source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/models/trial/config.py)).
따라서 이미 저장한 OPOD 대화를 arbitrary checkpoint에서 Harbor native session으로 load하는 설계에
기대면 안 된다.

OPOD에는 다음 선택이 적절하다.

- v1: single-step task 하나에서 runner가 24~48 user/assistant pair 전체를 진행
- v2: 관계 형성 → topic shift → delayed recall → 갈등/repair → closure 같은 큰 phase만 Harbor
  multi-step으로 분리
- 매 개별 chat turn을 Harbor step으로 만드는 방식은 orchestration overhead와 결과 구조가 과도하다.

## RewardKit과 LLM-as-a-judge

RewardKit은 Harbor와 독립적으로도 쓸 수 있는 verifier package다. Python criterion과 TOML judge를
한 directory에서 발견해 병렬 실행하고, workspace와 ATIF trajectory를 평가한다
([RewardKit](https://www.harborframework.com/docs/rewardkit)).

```bash
# tests/test.sh
#!/usr/bin/env bash
set -euo pipefail
uvx --from harbor-rewardkit==0.1.7 rewardkit /tests \
  --workspace /app \
  --output /logs/verifier/reward.json \
  --max-concurrent-llm 2
```

결정론적 criterion 예시는 다음과 같다.

- ATIF schema valid
- user/agent turn alternation과 최소 turn 수
- HTTP 오류, 빈 응답, timeout 수
- delayed-recall probe의 exact/semantic fact match
- duplicate response 비율, p95 latency, token/cost ceiling
- session/turn ID uniqueness와 memory contamination 없음

TOML judge는 ATIF를 직접 읽을 수 있다
([Judge Criteria](https://www.harborframework.com/docs/rewardkit/judge-criteria)).

```toml
# tests/continuity/quality.toml
[judge]
judge = "<provider>/<judge-model>"
atif-trajectory = "/logs/agent/trajectory.json"
mode = "batched"
timeout = 300
reasoning_effort = "medium"

[[criterion]]
id = "continuity.delayed_recall"
name = "delayed_recall"
description = "대화 초반의 사용자 사실을 나중에 정확하고 과장 없이 활용했는가?"
type = "likert"
points = 5
weight = 2.0

[[criterion]]
id = "continuity.topic_return"
name = "topic_return"
description = "주제가 여러 번 바뀐 뒤 이전 맥락으로 자연스럽게 복귀했는가?"
type = "likert"
points = 5

[[criterion]]
id = "quality.non_repetition"
name = "non_repetition"
description = "상투적 문구, 질문, 요약을 기계적으로 반복하지 않았는가?"
type = "likert"
points = 5
```

RewardKit은 directory별 score를 별도 reward key로 만들고 root `reward.toml`에서
`weighted_mean | all_pass | any_pass | threshold` 방식의 aggregate key를 추가할 수 있다. 결과는 다음
두 파일이다.

- `reward.json`: Harbor가 읽는 수치 score들
- `reward-details.json`: criterion별 score, judge reasoning, error; `harbor view`에서 펼쳐 볼 수 있음

주의할 점이 있다.

1. RewardKit 문서의 일반 예시는 trajectory path를 `/logs/trajectory.json`으로 쓰지만 Harbor agent의
   표준 위치는 `/logs/agent/trajectory.json`이다. OPOD rubric에는 후자를 명시한다
   ([environment paths source](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/models/trial/paths.py)).
2. shared verifier는 agent container를 재사용한다. judge key는 `[verifier.env]`로 agent run 이후에만
   주입할 수 있다. 더 강한 격리가 필요하면 separate verifier를 쓰되, separate verifier에는 agent
   logs가 자동 전달되지 않으므로 `/logs/agent/trajectory.json`을 task artifact로 명시해야 한다
   ([separate verifier changelog](https://github.com/harbor-framework/harbor/blob/v0.20.0/CHANGELOG.md#2026-05-14--separate-verifier-environments)).
3. 긴 trajectory는 judge context에 맞도록 각 step을 비례 truncation한다. 전체 구조는 남지만 세부
   문장이 잘릴 수 있다
   ([RewardKit trajectory formatter](https://github.com/harbor-framework/harbor/blob/v0.20.0/packages/rewardkit/src/rewardkit/trajectory.py)).
   따라서 critical fact recall은 programmatic check로도 중복 검증하고, phase별 transcript artifact를
   별도 judge input으로 제공하는 편이 낫다.
4. RewardKit `0.1.7`의 judge config에는 timeout/reasoning effort는 있지만 공통 seed나 temperature
   항목은 없다
   ([judge models](https://github.com/harbor-framework/harbor/blob/v0.20.0/packages/rewardkit/src/rewardkit/models.py)).
   LLM judge score를 완전 결정론적으로 간주하지 말고 반복·다중 judge와 분산 보고를 사용해야 한다.

## OPOD 최소 통합안

### 권장 파일 배치

```text
evals/harbor/
├── README.md
├── job.yaml
├── opod_conversation_agent.py
├── run_conversation.py
└── tasks/
    ├── casual-delayed-recall/
    │   ├── instruction.md
    │   ├── task.toml
    │   ├── environment/
    │   │   ├── Dockerfile
    │   │   └── scenario.json
    │   └── tests/
    │       ├── test.sh
    │       ├── common_checks.py
    │       ├── reward.toml
    │       ├── integrity/check.py
    │       ├── continuity/judge.toml
    │       ├── persona/judge.toml
    │       └── naturalness/judge.toml
    ├── topic-drift-and-return/
    ├── correction-and-repair/
    ├── emotional-continuity/
    ├── persona-boundary-pressure/
    └── context-rollover/
```

stable `v0.20.0` 기준 최소 task config는 다음처럼 시작할 수 있다. image와 host 이름은 배포 환경에
맞게 바꾼다.

```toml
# tasks/casual-delayed-recall/task.toml
schema_version = "1.3"

artifacts = [
  "/logs/agent/trajectory.json",
  "/logs/agent/conversation.jsonl",
  "/logs/agent/run-metrics.json",
]

[task]
name = "opod/casual-delayed-recall"
description = "30-minute-equivalent casual conversation with delayed recall"

[agent]
timeout_sec = 2400.0

[verifier]
timeout_sec = 900.0

[verifier.env]
OPENAI_API_KEY = "${JUDGE_OPENAI_API_KEY}"

[environment]
docker_image = "ghcr.io/<org>/opod-eval@sha256:<digest>"
workdir = "/app"
network_mode = "public"
```

위처럼 prebuilt `docker_image`를 쓰면 task의 `environment/Dockerfile`은 생략하고
`environment/scenario.json`을 `/app` workdir에 upload하게 할 수 있다. Dockerfile을 직접 빌드하는
방식이면 `scenario.json`을 image의 `/app`으로 명시적으로 `COPY`한다. Harbor의 top-level
environment healthcheck는 `agent.setup()`보다 먼저 실행되므로, 위 single-container 안에서는 custom
agent `setup()`이 OPOD를 시작하고 직접 readiness를 확인한다. OPOD를 Compose sidecar로 분리했다면
Compose healthcheck와 `main.depends_on`을 쓰는 쪽이 맞다.

반복과 key 분리는 job config에 둔다.

```yaml
# evals/harbor/job.yaml
job_name: opod-long-chat-v1
jobs_dir: evals/harbor/jobs
n_attempts: 3
n_concurrent_trials: 2

tasks:
  - path: evals/harbor/tasks/casual-delayed-recall

agents:
  - import_path: evals.harbor.opod_conversation_agent:OpodConversationAgent
    model_name: <sut-provider>/<sut-model>
    kwargs:
      simulator_model: <provider>/<simulator-model>
      profile: accelerated-30m
    env:
      OPENAI_API_KEY: "${SIMULATOR_OPENAI_API_KEY}"

environment:
  type: docker
  env:
    LLM_API_KEY: "${SUT_LLM_API_KEY}"

verifier:
  env:
    OPENAI_API_KEY: "${JUDGE_OPENAI_API_KEY}"
```

task-level과 job-level verifier env가 겹치면 run-level override가 적용된다. 실제 provider가 OpenAI가
아니면 RewardKit/LiteLLM이 요구하는 provider별 환경 변수 이름으로 교체한다.

### “30분” 실행 계약 제안

다음은 Harbor의 공식 정의가 아니라 OPOD 평가를 위한 제안이다.

`accelerated-30m`을 CI 기본 profile로 둔다.

- 24~48 user/assistant pair
- scenario에 선언된 5개 이상의 phase를 모두 통과
- simulator가 관리하는 `simulated_elapsed_sec >= 1,800`
- 초반 fact를 최소 12 turn 뒤 다시 묻는 delayed-recall probe 포함
- topic shift, interruption, correction, mild disagreement, closure를 각각 최소 한 번 포함
- fatal HTTP error 0, 유효 ATIF, 완결된 종료 사유 필수
- sleep은 하지 않아 실제 runtime은 단축

별도로 nightly `wall-clock-30m` profile을 소수 trajectory에 실행한다.

- 실제 monotonic elapsed time `>= 1,800s`
- 현실적인 user think delay 또는 외부 human pilot 허용
- streaming disconnect, timeout, memory consolidation 같은 시간 의존 문제 탐지

두 profile을 구분해야 “실제 30분 안정성”과 “30분 분량의 대화 품질”을 혼동하지 않는다.

### Scenario/trajectory matrix 제안

| 축 | 최소 사례 | 핵심 관찰 |
| --- | --- | --- |
| 관계 지속 | casual rapport, 취향 공유 | 앞선 사실의 자연스러운 재사용 |
| 주제 전환 | 3회 이상 drift 후 복귀 | 맥락 복구, 억지 요약 없음 |
| 수정/갈등 | 사용자가 앞선 사실을 정정 | 즉시 수용, 잘못된 기억 재사용 없음 |
| 감정 연속성 | 분위기 변화와 회복 | 톤 적합성, 과잉 공감 없음 |
| persona 압력 | 설정 밖 행동 유도 | character 일관성과 유연성 |
| context rollover | 긴 history, history offset 변화 | summary/memory watermark 정확성 |
| 장애 회복 | 한 turn retry, SSE 중단 | turn idempotency, 중복 응답 없음 |
| 격리 | 병렬 user/session | cross-session memory leakage 없음 |

각 scenario는 고정 seed 3개 이상을 explicit task data로 가진다. Harbor에는 job 전체에 적용되는 일반
seed 필드가 없으므로 seed를 custom agent kwargs 또는 `scenario.json`에 넣고, ATIF `extra`,
`run-metrics.json`, job config에 모두 남긴다.

### 점수 계약 제안

한 개의 종합 점수만 남기지 않고 최소 다음 key를 유지한다.

```json
{
  "integrity": 1.0,
  "continuity": 0.84,
  "persona": 0.91,
  "naturalness": 0.78,
  "memory": 0.88,
  "recovery": 1.0,
  "reward": 0.85
}
```

권장 pass 규칙은 `integrity == 1`, `recovery == 1`, 나머지 핵심 차원별 하한, 그리고 전체
`reward` 하한을 동시에 요구하는 것이다. judge score만으로 pass/fail을 만들지 말고 deterministic
gate와 결합한다. suite 수준에서는 단일 최고 점수보다 scenario별 pass rate, 중앙값, 하위 10%와
실패 taxonomy를 보고한다.

## 결과 형식과 분석

일반 single-step job의 핵심 산출물은 다음과 같다
([Run Evals](https://www.harborframework.com/docs/run-jobs/run-evals),
[`TrialPaths`](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/models/trial/paths.py)).

```text
jobs/<job-name>/
├── config.json
├── lock.json
├── result.json
└── <trial-name>/
    ├── config.json
    ├── lock.json
    ├── result.json
    ├── trial.log
    ├── agent/
    │   ├── trajectory.json
    │   ├── conversation.jsonl
    │   └── run-metrics.json
    ├── verifier/
    │   ├── reward.json
    │   ├── reward-details.json
    │   ├── test-stdout.txt
    │   └── test-stderr.txt
    └── artifacts/
        └── manifest.json
```

multi-step trial은 `steps/<step-name>/{agent,verifier,artifacts}` 아래에 step별 결과를 둔다. trial
`result.json`에는 `agent_info`, `agent_result`, `verifier_result`, exception, timing, multi-step
`step_results`가 들어간다
([TrialResult](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/models/trial/result.py)).

`/logs/artifacts/`는 별도 설정 없이 수집되며, 임의 container path는 task/job `artifacts` 설정으로
수집할 수 있다. `manifest.json`은 source, destination, service, status를 기록한다
([Artifact Collection](https://www.harborframework.com/docs/run-jobs/results-and-artifacts)).

## 재현성 체크리스트

Harbor의 `lock.json`은 Harbor version/git commit, task content digest, resolved git commit, agent/env/
verifier config, skill digest, extra instruction digest를 기록한다
([lock model](https://github.com/harbor-framework/harbor/blob/v0.20.0/src/harbor/models/job/lock.py)).
이것만으로 외부 LLM rollout이 bit-for-bit 재현되지는 않는다.

다음을 추가로 고정·기록해야 한다.

- Harbor `0.20.0`, RewardKit `0.1.7`, task schema `1.3`
- OPOD git SHA와 build artifact/image digest
- SUT, simulator, judge의 provider/model snapshot ID
- 각 모델의 temperature/top-p/seed 등 지원되는 sampling parameter
- persona, system prompt, memory policy, rubric의 version/hash
- scenario ID와 simulator seed
- Docker base image를 mutable tag가 아닌 digest로 고정
- wall-clock profile의 timezone, 시작 시각, synthetic time schedule
- 모든 request ID, turn ID, retry 횟수, latency와 HTTP/SSE 오류
- raw ATIF와 `reward-details.json` 보존

평가 보고에는 최소 3개 seed/attempt의 평균만 쓰지 말고 표준편차 또는 bootstrap interval, scenario별
최저점, judge disagreement를 포함한다. 모델/provider가 seed를 보장하지 않으면 “동일 config의 반복
sampling”이라고 표현하고 deterministic replay라고 부르지 않는다.

## 보안·운영 주의

- judge API key는 task source에 literal로 넣지 말고 `${VAR}`와 `[verifier.env]` 또는 `--ve`로
  주입한다. Harbor는 verifier phase에서 이를 resolve한다
  ([LLM-as-a-Judge tutorial](https://www.harborframework.com/docs/tutorials/llm-as-a-judge)).
- 실제 사용자 대화를 평가 데이터로 복사하지 말고 우선 synthetic user만 사용한다. ATIF와 raw logs는
  대화 전문을 담으므로 retention/접근 제어 대상이다. 이는 Harbor가 자동 해결하지 않는다.
- shared verifier보다 separate verifier가 rubric·key 격리에 유리하다. separate 환경을 쓰면
  `tests/Dockerfile`이 `/tests/test.sh`를 image 안에 포함해야 하고, 필요한 agent artifact를 명시적으로
  전달해야 한다.
- `main`은 빠르게 변하고 breaking change가 있었다. stable exact pin으로 시작하고 upgrade는 별도
  compatibility job에서 `config.json`, `lock.json`, ATIF validation, score parity를 확인한 뒤 한다.

## 구현 순서

1. `casual-delayed-recall` task 하나, custom agent 하나, deterministic verifier만으로 12-turn smoke
   trajectory를 만든다.
2. 같은 runner를 `accelerated-30m`으로 늘리고 ATIF validator와 raw log/artifact 수집을 붙인다.
3. RewardKit `integrity + continuity + persona + naturalness` 차원을 추가한다.
4. scenario 6종 × seed 3개, `n_attempts=2`로 nightly suite를 만든다.
5. 실패 trajectory를 사람이 blind-review해 judge rubric과 threshold를 calibration한다.
6. 실제 1,800초 wall-clock trajectory와 병렬 session contamination test를 별도 nightly job으로
   추가한다.
7. 안정화 뒤에만 separate verifier, cloud sandbox, Harbor multi-step checkpoint 평가를 도입한다.

이 순서는 Harbor 기능을 최대한 재사용하면서도 OPOD 고유 로직을 `run_conversation.py`와 rubric에
격리한다. Harbor fork나 custom environment provider는 필요하지 않다.

## 주요 공식 출처

- [Harbor 공식 문서](https://www.harborframework.com/docs)
- [Harbor 공식 GitHub](https://github.com/harbor-framework/harbor)
- [v0.20.0 release](https://github.com/harbor-framework/harbor/releases/tag/v0.20.0)
- [Getting Started](https://www.harborframework.com/docs/getting-started)
- [Task Structure](https://www.harborframework.com/docs/tasks)
- [Multi-step Tasks](https://www.harborframework.com/docs/tasks/multi-step)
- [Custom Agents](https://www.harborframework.com/docs/agents)
- [ATIF](https://www.harborframework.com/docs/agents/trajectory-format)
- [RewardKit](https://www.harborframework.com/docs/rewardkit)
- [RewardKit Judge Criteria](https://www.harborframework.com/docs/rewardkit/judge-criteria)
- [Run Evals / result viewer](https://www.harborframework.com/docs/run-jobs/run-evals)
- [Artifact Collection](https://www.harborframework.com/docs/run-jobs/results-and-artifacts)
