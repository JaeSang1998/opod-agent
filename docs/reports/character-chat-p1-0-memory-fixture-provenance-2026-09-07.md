# 캐릭터 챗 P1-0 — 실제 Memory fixture와 provenance 결과

- 작성일: 2026-09-07
- 범위: 모든 캐릭터가 공유하는 Memory 검색·주입 경로와 평가 harness
- 구현 상태: **P1-0 완료**
- 구조 판정: **PASS**
- lifecycle 정책 판정: **FAIL — 현행 기준선으로 보존**
- 대화 자연스러움 판정: **하지 않음**

## 결론

이전 48턴 평가에서는 회수된 사용자 Memory가 전부 0건이어서 Memory 구조를 실제로 시험했다고 볼 수
없었다. 이번에는 합성 Memory 8건을 격리된 in-process Store에 실제로 저장하고, 고정 사용자 발화를
embedding해 제품의 검색·top-K·turn-context·HTTP debug 경로를 끝까지 통과시켰다.

배관 자체는 정상이다. 8/8건이 저장됐고, 8건 전부의 순위와 선택·제외 사유가 기록됐으며, 선택된
6건이 실제 turn context에 들어갔다. 동시에 현행 정책 결함도 재현됐다. 현재 사실뿐 아니라
`superseded`, `forgotten`, `stale` Memory가 모두 주입됐다. 지금 검색기는 lifecycle을 판단하지 않고
가중 점수 상위 K개를 채우기 때문이다.

이 결과의 `STRUCTURE-PASS`는 자연스러운 답변이라는 뜻이 아니다. 실제 모델이나 자동 judge를 쓰지
않았고, 구조 전용 mode는 `qualityPassed=false`, `passed=false`, `certificationEligible=false`를
명시적으로 기록한다.

## 무엇을 변경했나

| 영역 | 변경 | 동작 영향 |
| --- | --- | --- |
| Retrieval scorer | 선택된 top-K뿐 아니라 모든 후보의 rank, weighted score, raw relevance, 선택·제외 사유를 반환 | 기존 top-K 결과와 가중식은 그대로 유지 |
| MemoryStore | 선택 사항인 `retrieveWithTrace` 계약 추가; Stub/Postgres가 구현 | 외부·구형 adapter는 기존 `retrieve`로 계속 동작 |
| ChatService debug | Memory ID·kind·rank·score·회수 사유·실제 주입 여부 기록 | `x-opod-debug: 1` 요청에만 노출; Memory 원문 없음 |
| Eval fixture | `active/stale/superseded/forgotten` archival record와 `active/expired` current-state record 계약 추가 | P1-0에서는 archival 8건만 seed; current state는 P1-3용 선언만 함 |
| Eval preflight | seed 누락, provenance 누락, 후보 0, 주입 0, 제외 0, positive probe 실패를 runtime failure로 처리 | Memory 0건 실행을 Memory 성공으로 표시할 수 없음 |
| Eval mode | `structure`를 품질 평가와 분리 | 구조 성공을 자연스러움 PASS로 오인하지 않음 |

provenance에는 다음 흐름만 남는다.

`fixture ID → runtime Memory ID → retrieval rank/decision → prompt injection 여부`

Memory 문장, 사용자 발화, Persona 원문은 이 metadata에 복사하지 않는다.

## 실제 실행 결과

실행 명령:

```bash
npm run eval:memory-structure
```

최종 artifact:

- [`suite-report.json`](../../evals/results/2026-09-07T04-32-04-507Z/suite-report.json)
- [`trajectory.json`](../../evals/results/2026-09-07T04-32-04-507Z/trajectory.json)
- [개별 trajectory 결과](../../evals/results/2026-09-07T04-32-04-507Z/trajectories/shared-memory-provenance-r1-188230bd/result.json)

개별 run ID는 artifact 생성 때마다 달라지므로 위 마지막 링크가 이동했을 경우 같은 디렉터리의
`trajectories/*/result.json`을 본다.

| 관측 항목 | 결과 |
| --- | --- |
| Store seed | 8/8 |
| 선언된 current-state record | 2건; P1-0에서는 미주입 |
| retrieval 후보 provenance | 8/8 |
| top-K 선택 및 실제 주입 | 6건 |
| top-K 제외 | 2건 |
| runtime ID 매핑 실패 | 0건 |
| 현재 사실 positive probe | 통과 |
| 과거·삭제·오래된 사실 제외 기대 | 실패 |
| runtime error | 없음 |

실제 선택·주입된 fixture ID:

1. `current-residence` — active, 기대한 현재 사실
2. `old-residence` — superseded, 주입되면 안 되는 과거 사실
3. `forgotten-address` — forgotten, 주입되면 안 되는 삭제 대상
4. `stale-commute` — stale, 현재 답변에 쓰면 안 되는 오래된 상태
5. `privacy-reflection` — active
6. `active-drink` — active지만 현재 질문에는 부차적

제외된 것은 `active-pet`, `active-work`였다. 즉 현행 top-K는 “유효한가”를 먼저 판단하지 않고,
정정·삭제·오래된 record도 active record와 같은 후보군에서 경쟁시킨다. 이 때문에 무관한 active
Memory보다 무효 Memory가 먼저 프롬프트에 들어갈 수 있다.

## DB와 모델 사용 범위

이번 P1-0 실행은 개발 DB dump를 만들지 않았다. `DATABASE_URL`과 원격 `EVAL_TARGET_URL`을 사용하지
않고 trajectory마다 새 `StubMemoryStore`를 만들었다. 구조 결과를 결정론적으로 재현하기 위해
test provider의 embedding과 짧은 합성 응답을 사용했지만, Persona 조회, ChatService, 실제 retrieval
scorer, Store, turn-context 조립, Hono HTTP 응답 debug는 제품 경로를 그대로 통과했다.

따라서 이 실행이 증명하는 것은 “Memory가 실제 제품 경로에 들어갔고 그 출처를 감사할 수 있다”까지다.
실제 모델 답변이 자연스러워졌다는 주장은 하지 않는다.

## P1-1 진입 조건

다음 단계는 공용 `Persona Router`다. 특정 캐릭터 이름이나 문구별 예외를 만들지 않고 모든 Persona
block을 같은 입력 계약으로 투영한다.

1. `always`: 정체성, 관계 경계, 핵심 행동·voice만 매 turn 유지
2. `start_only`: 첫 만남에만 필요한 소개 정보
3. `retrieved`: 직전 사용자 발화와 관련될 때만 후보로 제공할 배경·직업·게시물·취미 정보
4. `never_prompt`: 운영 metadata와 생성용 설명처럼 runtime DM에 직접 넣지 않을 정보

P1-1은 먼저 fixture/read adapter에서 이 네 경로와 provenance를 검증한다. 운영 DDL이나 캐릭터별
hard-code는 하지 않는다. 같은 고정 대화에서 Persona-only 조건을 비교해, 직업·게시물·대표 소재가
사용자 발화보다 먼저 튀어나오는 비율이 실제로 줄었을 때만 schema 변경 후보로 올린다.
