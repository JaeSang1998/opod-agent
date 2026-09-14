# 캐릭터 챗 P0-4 Blind Review 준비 결과

- 준비일: 2026-09-02
- 상태: **PACKETS READY — REVIEW DEFERRED BY USER DECISION (2026-09-03)**
- 원본: ignored diagnostic `suite-report.json`
- 원본 SHA-256: `004d49d59fb1c6f4d52f217eb39c0d8c5859af65ff6a158e48c000f83fab8759`
- 표본: 8 trajectory, 2 scenario, 캐릭터 4개, trajectory당 6 exchange
- 외부 호출: 없음

## 2026-09-03 실행 결정

사용자는 이번 답변 개선을 본인이 기존 스모크에 남긴 22개 사후검수 주석만으로 진행하도록
결정했다. 따라서 아래 packet과 집계 도구는 보존하지만 추가 reviewer 모집과 submission 집계는
현재 iteration에서 수행하지 않는다. 이 보류는 기존 1인 seed를 blind, adjudicated 또는 gold로
승격한다는 뜻이 아니다.

## 생성 결과

출력 경로는
[`evals/results/p0-human-blind-review-2026-09-02`](../../evals/results/p0-human-blind-review-2026-09-02)다.
이 경로는 `.gitignore` 대상이며 패킷 원문, private mapping과 reviewer 제출물을 commit하지 않는다.

| Reviewer | Packet ID | Trajectory | Pair | 전달 파일 |
| --- | --- | ---: | ---: | --- |
| A | `packet-aad6437fb2bc` | 8 | 4 | `reviewer-a.packet.md`, `reviewer-a.submission.json` |
| B | `packet-762ec9608776` | 8 | 4 | `reviewer-b.packet.md`, `reviewer-b.submission.json` |

두 packet은 같은 표본과 같은 underlying pair를 사용하지만 trajectory 순서와 pair 좌우가 반대다.
Packet에는 익명 Persona brief와 사용자·캐릭터 발화만 들어간다. 다음 정보는 제거했다.

- 캐릭터 이름과 ID
- 원래 run ID
- candidate, simulator, judge 모델
- 자동 점수와 PASS/FAIL
- scripted/simulated user-source 표식
- 기존 22개 사람 주석과 판정

생성 후 packet JSON과 Markdown에서 위 이름·ID·run ID·자동판정 필드의 literal 누출이 없는지 별도로
검색했고 발견되지 않았다. Private key만 원본 transcript ID, 자동 판정과 packet mapping을 보유한다.

## 배포 규칙

1. Reviewer A에게 A의 packet과 submission만 전달한다.
2. Reviewer B에게 B의 packet과 submission만 전달한다.
3. `_PRIVATE-review-key.json`, 상대방 파일, 기존 스모크 원문·점수·검수 보고서를 전달하지 않는다.
4. 기존 22개 예시를 이미 본 사람은 이 표본의 blind reviewer로 세지 않는다.
5. Reviewer는 서로 상의하지 않고 pairwise 4개를 먼저 판정한 뒤 trajectory 8개를 판정한다.
6. `fail`은 tag, 최소 evidence turn과 구체적 이유를 모두 기록한다.
7. `reviewerAlias`를 서로 다른 비식별 가명으로 교체한다.
8. 완료 시 submission의 `status`를 `complete`로, `completedAt`을 실제 완료 시각으로 바꾼다.

## 집계 계약

두 submission이 들어오면 `eval:review:aggregate`가 다음을 검증한다.

- 두 packet 모두 정확히 한 번 제출됨
- 서로 다른 reviewer alias
- 모든 trajectory와 pair의 완결성
- `fail` evidence와 실제 turn 범위
- `not-reviewed`가 남지 않은 complete 상태

통과하면 다음을 계산한다.

- reviewer 간 trajectory exact agreement
- 좌우 방향을 원본 transcript로 정규화한 pairwise agreement
- 자동 judge와 각 reviewer의 exact agreement
- 자동 PASS·사람 FAIL인 false-pass
- 자동 FAIL·사람 PASS인 false-fail
- 불일치와 기권으로 남은 adjudication 대상

집계 결과에는 항상 `adjudicated: false`가 기록된다. 두 사람이 모두 같은 판정을 했더라도 tooling이
gold나 calibrated 상태로 자동 승격하지 않는다.

Tooling은 동일 reviewer alias를 거부하지만 실제 사람의 동일성까지 인증하지는 못한다. 운영자가 두
submission이 서로 다른 독립 reviewer에게서 왔는지 별도로 확인해야 한다.

## 현재 해석

아직 사람 submission이 없으므로 agreement, false-pass, false-fail의 새로운 수치는 **미측정**이다.
기존 1인 사후검토 seed는 패킷 생성이나 두 reviewer 판정에 입력하지 않았고 계속
`seed/uncalibrated`로 남는다. Pairwise AI judge 출력도 기존 실행에 없으므로 이번 집계가 계산하는
judge-human 수치는 trajectory PASS/FAIL 기준이며, pairwise judge-human agreement는 별도 모델 실행
없이는 계산할 수 없다.

Blind calibration을 다시 시작할 경우의 완료 조건은 실제 blind reviewer 두 명의 submission을 받은
뒤 집계하고, 불일치만 합의 검수해 최종 gold 승격 여부를 사람이 결정하는 것이다. 현재 P0-R1의
완료 조건에는 이 절차를 포함하지 않는다.
