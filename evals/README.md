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

# 공통 자연스러움 진단: 모든 runtime character × 8 scenario × 12 exchanges
EVAL_CHARACTER_SET_PATH=/absolute/path/to/character-set.json npm run eval:naturalness

# P1-0 공용 메모리 구조: 실제 in-process Store seed + 회수/제외/주입 provenance
npm run eval:memory-structure

# P1-1 공용 Persona Router: 동일 문맥의 legacy control / routed candidate 구조 A/B
npm run eval:persona-router

# 승인된 Persona 원문 구간을 실험 입력에서만 분리. 모델·DB 호출 없음
EVAL_PERSONA_INPUT=/absolute/path/to/control-personas.json \
  EVAL_PERSONA_PROJECTION=/absolute/path/to/source-projection.json \
  npm run eval:persona-projection
```

`eval:persona-projection`은 기존 `Persona[]` JSON과 내용 없는 구간 계획을 읽는다. 계획은
`schemaVersion: 1`, `offsetUnit: "utf8_bytes"`, `sources` 배열이며, 각 source는 `blockId`,
원문 `sourceSha256`, `fragments`를 가진다. 각 fragment는 `startByte/endByte`, 기존
`kind/injection` 값을 명시한다. 원문 전체를 빈틈·중복 없이 나눠야 하며 SHA-256 불일치와
UTF-8 문자 중간 경계는 실패한다. 계획에 없는 블록·examples·canon은 그대로 유지한다.
구간에는 원본 ID·hash·byte 범위에 기반한 ID를 부여하고 내용 없는 `sourceSpans`를 별도로 남긴다.
포함 정책은 기존 `routePersona`를 사용하며 제품 Store나 실제 서비스 설정은 변경하지 않는다.

출력은 새 `EVAL_RESULTS_DIR` 또는 기본 ignored `evals/results/persona-projection-.../`에
`projected-personas.json`(원문 포함)과 `projection-report.json`(출처·구조 probe)을 저장한다.
출력 디렉터리는 새로 생성하며 기존 디렉터리·파일을 덮어쓰지 않는다. 디렉터리 권한은 0700,
파일은 0600이다. 실제 원문·구간 계획·출력은 git에 넣지 않는다. optional source가 0개인 조건과
모두 선택된 조건은 배치 검증용이며 실제 selector·모델 품질·전체 Persona routing 완료를 뜻하지 않는다.

`eval:validate`와 `test:eval*`에서 쓰는 fixture/test double은 schema와 집계기의 false-pass 방지용일
뿐 대화 품질 실행으로 세지 않는다. H30 인증에는 실제 candidate, simulator, judge endpoint를 호출한
`eval:long`/`eval:confidence` artifact가 필요하다. 아래 국소 비교는 별도 사용자 검수용 진단이다.

## P1-0 공용 메모리 구조 probe

`eval:memory-structure`는 대화 자연스러움을 채점하는 명령이 아니다. 특정 캐릭터의 Persona나 말투와
무관하게, 합성 사용자 메모리 8건을 실제 `StubMemoryStore`에 넣고 첫 고정 발화를 embedding한 뒤 현재
검색기가 어떤 ID를 선택·제외했으며 어떤 ID가 turn context에 들어갔는지 검증한다. fixture에는
`active`, `stale`, `superseded`, `forgotten` archival label과 `active`, `expired` current-state label이
모두 있다. 출력 provenance에는 메모리 원문이나 사용자 발화가 아니라 ID, 종류, 순위, 점수,
선택·제외 사유, 주입 여부만 남는다.

Suite mode도 별도 `structure`로 기록한다. 따라서 구조 preflight가 성공해도 품질 필드인
`qualityPassed`, `passed`, `certificationEligible`은 모두 `false`이며 자연스러움 PASS로 승격되지 않는다.

이 기본 명령은 응답 문장 품질과 무관한 구조 검사를 재현 가능하게 만들기 위해 deterministic test
provider의 embedding과 짧은 합성 응답을 사용한다. 다만 `ChatService` → 실제 retrieval scorer →
`StubMemoryStore` → turn-context 조립 → HTTP 응답 debug의 제품 경로는 그대로 통과한다. 따라서 이
결과를 실제 모델의 대화 품질 근거로 사용해서는 안 된다. `DATABASE_URL`은 명시적으로 무시하므로
개발 DB dump를 만들거나 운영·개발 DB에 쓰지 않으며, 각 trajectory의 격리된 in-process Store만
변경한다. `EVAL_TARGET_URL`이 설정된 원격 target과 runtime character-set은 fixture 오염을 피하려고
실행 전에 거부한다. 내장 Luna Persona는 HTTP prompt 경로를 통과시키는 합성 harness일 뿐이며,
fixture와 판정 조건에는 Luna 설정이나 특정 운영 캐릭터 정보가 없다.

구조 preflight는 다음 중 하나라도 만족하지 못하면 nonzero exit로 끝난다: 모든 record seed,
probe turn의 provenance 존재, 검색 후보 1건 이상, 실제 주입 1건 이상, top-K 제외 후보 1건 이상,
예상한 현재 record의 주입. 결과는 `suite-report.json`의 각 trajectory 아래
`memoryFixture.preflight`에서 확인한다. `memoryFixture.policyExpectationsPassed`는 별도 정보다. P1-0의
`baseline_unfiltered`는 lifecycle label을 일부러 저장 필터로 사용하지 않으므로, 과거·정정·삭제
record 제외 기대는 현재 `false`일 수 있다. 그 실패를 숨기지 않고 P1-2 Memory Gate 전후 비교의
기준선으로 보존한다. Current-state record는 P1-3 계약을 미리 선언하지만 P1-0에서는 아직 주입하지
않는다.

`eval:smoke|long|confidence`는 `.env`를 읽는다. Candidate는 기존 `LLM_*`/`EMBEDDING_*` 설정을
사용한다. simulator와 judge는 `EVAL_SIMULATOR_*`, `EVAL_JUDGE_*`로 분리하는 것을 권장한다. 값이
없으면 judge, 그 다음 candidate 설정으로 fallback하므로 로컬 연결 확인은 한 endpoint로도 가능하지만
동일 모델 self-judge 결과는 release 근거로 삼지 않는다.

## P1-1 Persona Router 구조 A/B

`eval:persona-router`는 서로 다른 내용과 제목을 가진 합성 Persona 2개에 동일한 3턴 사용자 문맥을
적용한다. Control은 매핑 없는 legacy Store, Candidate는 block ID 기반 explicit read adapter를 거쳐
`always/start_only/retrieved/never_prompt`로 나뉜다. fixture의 단순 문자열 rule은 `retrieved` 채널의
배관을 재현하기 위한 test-only selector이며 실제 relevance 알고리즘이 아니다.

결과는 JSON과 정적 HTML로 함께 생성한다. 각 source가 `system_prompt`, `turn_context`, `excluded` 중
어디에 있었는지 실제 조립된 prompt와 content-free provenance를 대조하고, 동적 Persona가 바뀌어도
stable prompt hash가 유지되는지 검사한다. 실제 모델 답변을 생성하지 않으므로 보고서의
`qualityPassed`, `passed`, `certificationEligible`은 항상 `false`다. 구조 통과를 대화 자연스러움
PASS로 해석하면 안 된다.

## 고정 Persona·prefix 국소 비교

`eval:persona-comparison`은 고정된 여러 `Persona[]` 입력을 기존 in-process HTTP target과
`ChatService` → provider 경로로 비교한다. `preflight`는 합성 응답만 생성하고, `run`은 설정한
실제 모델을 호출한다. simulator·judge는 사용하지 않으며 두 모드 모두 사용자 검수 전
`qualityPassed`와 `certificationEligible`은 `false`다.

```bash
# 4명 × 1상황 × 3조건 × 1반복인 manifest의 로컬 연결 검사
npm run eval:persona-comparison -- preflight \
  --manifest /absolute/path/to/comparison-smoke-manifest.json \
  --max-calls 12 --output /absolute/path/to/new-preflight-directory

# 실행 범위와 비용이 승인된 뒤, 인증값을 노출하지 않는 방식으로 LLM_API_KEY를 환경에 제공
LLM_BASE_URL=https://provider.example.com/v1 LLM_MODEL=approved-model \
  EVAL_TARGET_TEMPERATURE=1 EVAL_TARGET_TOP_P=0.95 EVAL_TARGET_MAX_TOKENS=8192 \
  npm run eval:persona-comparison -- run \
  --manifest /absolute/path/to/comparison-smoke-manifest.json \
  --max-calls 12 --output /absolute/path/to/new-model-directory
```

Manifest는 `schemaVersion: 1`, ISO `clock`, IANA `timezone`, `repetitions`, `reviewSeed`, 비교할
조건 ID 쌍인 `pairs`, `conditions`, `casesFile/casesSha256`을 가진다. 각 condition은
`id`, `personaFile`, 파일 byte의 `personaSha256`을 명시한다. 경로는 manifest 디렉터리를 기준으로
해석한다. Case 파일의 `cases` 항목마다 고유 `id`, user/assistant가 번갈아 나오고 user로 끝나는
`messages`, 선택적 `historyOffset`(기본 0), `reviewFocus`를 둔다. 검수 초점은 입력 설명이며
자동 점수나 패킷의 정답 힌트로 사용하지 않는다.

모든 파일 hash·ID·캐릭터 집합·이름/bio/canon 동일성과 전체 호출량을 첫 호출 전에 검사한다.
`--max-calls`는 캐릭터 수 × 조건 수 × 상황 수 × 반복 수 이상이어야 하며 일부만 실행하는
옵션이 아니다. `run`은 base URL·모델·출력 토큰 한도를 명시해야 한다. CLI는 `.env`나 DB를
자동으로 읽지 않는다. DB 설정은 `DbSettingsProvider`의 agent 우선/planner fallback 규칙으로
확인하고 기존 `baseUrlFrom`으로 operation URL을 base URL로 변환해, 실행 시작 때 고정한다.
API 키는 manifest·결과·Git에 저장하지 않는다.

응답마다 새 target/Store를 사용하고 같은 prefix를 복제하며 조건 순서를 순환한다. 생성 답변은
다음 조건이나 반복의 history로 넣지 않는다. 고정 시각, tools 없음, Bond·사용자 Memory 미추적,
consolidation 없음, optional Persona 선택 0으로 통일한다. 원격 `EVAL_TARGET_URL`은 이 로컬
override를 보장할 수 없어 거부한다. 실제 selector·지속 Memory 회수·긴 대화 검증은 별도다.

클라이언트 자동 재시도는 0회다. 첫 요청 실패, 응답 모델 누락/변경, `finish_reason != stop`,
prompt provenance·hidden state 불일치에서 중단한다. 응답을 먼저 `responses.jsonl`에 저장하므로
후속 실패가 앞선 유료 응답을 지우지 않는다. 재개·자동 재실행은 제공하지 않는다. 모델 공급자의
내부 routing/reasoning 설정은 이 명령이 고정하지 않으므로, 자동 제공사 선택을 쓰는 결과는 그
한계를 기록하고 통제된 품질 비교 전에 실제 제공사 조건을 확정해야 한다.

출력 디렉터리는 새로 생성하며 0700, 파일은 0600이고 덮어쓰지 않는다. 기본 경로는 ignored
`evals/results/`다. `comparison-report.json`은 요청 설정·관측 모델·토큰 사용량·prompt hash·
source provenance를, `input-provenance.json`은 manifest hash·Git HEAD/dirty 파일 hash를 남긴다.
중단 시 `incomplete.json`을 추가한다. 호출·출력 토큰 한도를 제한하지만 달러 예산을 직접 강제하지는 않는다.

각 비교 쌍마다 `review-N.md`, `review-N-packet.json`, `review-N-submission.json`, 운영자용
`review-N-private-key.json`이 생긴다. 같은 캐릭터·동일 prefix끼리만 짝지으며 조건과 모델을 가린다.
이름·원문을 고쳐 쓰지 않으므로 캐릭터 익명화 패킷은 아니다. 사용자 1인이 `left/right/tie/both_bad/abstain`을
먼저 작성하고 개별 판정을 보충한다. 자동 judge는 `not-judged`다. 기존 2인
`eval:review:aggregate`는 이 1인 패킷의 집계 명령이 아니며, 1인 결과의 자동 품질 판정은 제공하지 않는다.
합성 preflight 패킷에는 품질 검수 금지 안내가 붙는다.

## 공통 자연스러움 진단

`eval:naturalness`는 특정 캐릭터용 suite가 아니다. 동일한 8개 시나리오를 실행 시점에 전달한
캐릭터 집합 전체에 교차 실행한다. 코드와 공통 fixture에는 운영 캐릭터 ID, 이름, 말버릇이나
캐치프레이즈를 넣지 않는다. 캐릭터별 Persona 요약과 실제 target ID는 git 밖의 runtime
character-set 파일이 소유한다.

character-set은 실행 시점의 대상 범위를 완전하게 선언해야 한다. `expectedCharacterCount`와 실제
배열 길이가 다르거나, `key` 또는 `id`가 중복되거나, 캐릭터가 1명뿐이면 실행 전에 거부된다.
개발 환경 기준선은 읽기 전용으로 조회한 활성 캐릭터 전체를 한 snapshot에 넣는다.

```json
{
  "schemaVersion": 1,
  "scope": {
    "label": "example-snapshot",
    "capturedAt": "2026-09-02T00:00:00.000Z",
    "expectedCharacterCount": 2
  },
  "characters": [
    {
      "key": "alpha",
      "id": "runtime-target-alpha",
      "name": "Alpha",
      "personaVersion": "optional-source-version",
      "personaSummary": "Direct and dry, but considerate.",
      "canon": []
    },
    {
      "key": "beta",
      "id": "runtime-target-beta",
      "name": "Beta",
      "personaSummary": "Warm and playful without forcing questions.",
      "canon": []
    }
  ]
}
```

파일 경로는 `--characters` 또는 `EVAL_CHARACTER_SET_PATH`로 전달한다. 실제 내부 ID, Persona 원문,
DB 연결 정보가 들어갈 수 있으므로 이 파일은 저장소에 commit하지 않는다. 결과에는 suite와
character-set의 content hash, snapshot label과 시각, 전체 및 캐릭터별 통계, 누락된
`character:scenario` 셀, provisional 기준에 미달한 캐릭터 key가 기록된다. 전체 평균이 높더라도
캐릭터 하나가 최소 pass rate 또는 평균 점수에 미달하면 `qualityPassed`는 `false`다.

기본 in-process target은 synthetic Persona 하나만 소유한다. 운영 character-set을 proxy
응답으로 잘못 평가하지 않도록 diagnostic run에는 `EVAL_TARGET_URL`이 필수다. character-set의
`personaSummary`와 `canon`에는 judge가 필요한 검수된 공개 요약만 넣고 full prompt나 민감한 원문을
복사하지 않는다. `personaVersion`은 source DB가 안정적인 version 또는 snapshot 식별자를 제공할 때만
넣는 선택 필드다. 제공되지 않아도 실제 served prompt SHA-256이 비교 기준을 맡는다.
위의 고정 Persona 비교 명령은 별도 로컬 Store override를 사용하며 이 diagnostic CLI의 원격 조건을 바꾸지 않는다.

Naturalness suite의 `mode`는 `diagnostic`이다. 점수와 provisional quality 판정은 제공하지만
`certificationEligible`과 H30 `passed`는 항상 `false`다. 품질 점수가 낮다는 이유만으로 실행
프로세스를 실패시키지는 않지만, runtime/judge 실패, 캐릭터×시나리오 누락 또는 재현 manifest의
필수 관측값 누락은 nonzero exit로 처리한다. H30 suite는 character-set override를 허용하지 않아 기존
인증 의미를 보존한다.

Diagnostic judge에는 H30 공통 기준에 `local_relevance`, `natural_korean`,
`persona_without_motif`를 추가한다. `dm_style`은 이 모드에서 길이·Markdown·서술 같은 표면 형식만
판정한다. 한국어가 유창해 보여도 직전 문맥을 벗어나거나 사용자가 어색한 전제를 대신 이어 줘야
하면 자연스러운 대화로 보지 않는다. Persona·관계 단계에 맞는 반말·존댓말 혼용은 그 자체로
감점하지 않고, 게시물·프로필·직업·취미 소재를 대화보다 앞세우거나 반복 재연하면 감점한다.

Diagnostic simulator는 후보의 어색한 답을 열성적으로 받아 주거나 자연스럽게 고쳐 이어 가지
않는다. 이미 밝힌 사용자 이유를 반복하지 않고, 이후 scripted beat는 실제 문구가 아니라 목적만
보고 생성한다. 이 규칙은 후보 답변의 결함을 simulator가 가리는 것을 줄이기 위한 평가 입력 계약이며
production chat 동작에는 적용되지 않는다.

## 사람 평가와 보정 데이터

사람 평가 절차는
[`docs/evals/naturalness-human-review-guide.md`](../docs/evals/naturalness-human-review-guide.md)에
있다. 저장 계약은
[`evals/calibration/naturalness-gold.schema.json`](calibration/naturalness-gold.schema.json), 현재
초기 자료는
[`evals/calibration/naturalness-human-seed-2026-09-02.json`](calibration/naturalness-human-seed-2026-09-02.json)이다.

현재 seed는 자동 결과를 본 reviewer 한 명의 사후 검수다. 8개 trajectory의 자동 판정과 22개 사람
주석을 보존하지만 `status: seed`, `reviewerCount: 1`, `blind: false`, `method: posthoc`이므로 gold,
calibrated judge 또는 release 근거가 아니다. `adjudicated`는 최소 2명의 독립 blind reviewer가
필요하며 loader가 이 조건을 강제한다. Production transcript는 별도 데이터 정책 승인 전에는 보정
자료에 포함하지 않는다. 이 추가 진단과 seed는 기존 H30 rubric, 점수식, threshold,
certification 조건을 변경하지 않는다.

### Blind review 패킷

기존 diagnostic `suite-report.json`에서 reviewer 2명용 패킷을 만든다. 명령은 모델이나 DB를 호출하지
않으며, 출력 디렉터리가 이미 있으면 reviewer 작성물을 덮어쓰지 않고 실패한다.

```bash
npm run eval:review:prepare -- \
  --source /absolute/path/to/suite-report.json \
  --output /absolute/path/to/new-review-directory \
  --seed 20260902
```

출력에는 reviewer별 `.packet.md`, `.packet.json`, `.submission.json`과 운영자 전용
`_PRIVATE-review-key.json`이 생긴다. 각 reviewer에게 자신의 packet과 submission만 전달한다. 다른
reviewer 파일, private key, 기존 사람 주석 보고서, 자동 점수는 보여주지 않는다. Packet은 이름·ID,
run ID, 모델, 자동 점수·판정, scripted/simulated 표식을 제외하고 익명 Persona brief와 대화만
포함한다. 동일 trajectory의 표시 순서와 pair 좌우는 A/B에서 반대로 배치된다.

두 사람이 독립적으로 작성한 뒤 각 submission을 `status: complete`로 바꾸고 `completedAt`을 넣는다.
`reviewerAlias`도 두 사람이 서로 다른 비식별 가명으로 교체한다.
`fail`에는 tag, 최소 evidence turn, 이유가 모두 필요하다. 집계는 draft, 항목 누락, 잘못된 turn,
동일 reviewer alias를 거부한다.

```bash
npm run eval:review:aggregate -- \
  --key /absolute/path/to/_PRIVATE-review-key.json \
  --submissions /absolute/path/to/reviewer-a.submission.json,/absolute/path/to/reviewer-b.submission.json \
  --output /absolute/path/to/new-agreement-directory
```

결과는 reviewer 간 trajectory·pairwise 일치율, 자동 judge 대비 각 reviewer의 일치율,
false-pass·false-fail, adjudication 대상을 기록한다. 집계기는 결과가 모두 일치해도 gold artifact를
자동 생성하거나 `adjudicated`로 승격하지 않는다. Reviewer가 기존 원문이나 22개 예시를 이미 본
경우 blind reviewer로 세지 않는다. 생성 패킷과 private key, 제출물, agreement 결과는
`evals/results/` 아래 ignored artifact로 유지하고 commit하지 않는다.

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
baseline-manifest.json            # 원문 없는 실행 재현·비교 가능성 metadata
harbor-reward.json                # 숫자 값만 갖는 Harbor reward payload
trajectory.json                   # 최저 점수 run의 ATIF v1.7 (RewardKit용)
trajectories/<run-id>/result.json
trajectories/<run-id>/trajectory.atif.json
```

`suite-report.json.baseline`과 `baseline-manifest.json`은 같은 객체다. 모델과 generation 설정,
observed response model, suite/character-set SHA-256, Git HEAD·dirty path SHA-256, 캐릭터별 stable
prompt SHA-256과 block/canon 수, retrieval/consolidation 설정을 기록한다. `comparison.ready`가
`false`면 `reasons`에 누락·불일치 원인이 들어가며 그 실행끼리 품질 차이를 주장하면 안 된다.

실제 served prompt fingerprint는 non-streaming 요청의 `x-opod-debug` opt-in 응답에서 얻는다.
metadata에는 hash/count/context section 이름만 있고 Persona, canon, Memory, 사용자 발화 원문은 없다.
header가 없는 일반 응답에는 `opod_debug`가 추가되지 않는다.

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

PR workflow는 fixture, harness 회귀 테스트, pinned Harbor task 계약만 검증한다. 실제 모델을
호출하는 workflow_dispatch의 기본 profile은 scenario당 3회인 `confidence`다. 현재 threshold는 human
gold transcript calibration 전의 `H30-provisional` 기준이다.
