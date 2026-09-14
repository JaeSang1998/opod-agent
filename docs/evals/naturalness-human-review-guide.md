# 캐릭터 챗 자연스러움 사람 평가 가이드

- 버전: 1
- 작성일: 2026-09-02
- 적용 범위: `mode: diagnostic` 자연스러움 평가
- 비적용 범위: H30 인증 점수·threshold·critical failure 계약

현행 프로젝트 검수는 사용자 1인·동일 캐릭터 원문 보존·조건 가림을 따른다. 최종 달성 기준의
v1 작업 기준과 표본·계산법은 [현행 계획](../character-chat-products-persona-memory-research-2026-09-03.md)의
10.4절·10.6절이 소유한다. 아래 2인 검수·이름 가림·gold 승격 절차는 과거 calibration 계약으로
보존하며 이번 프로젝트 완료의 선행 조건으로 요구하지 않는다. 이 문서 수정은 집계 도구 변경이 아니다.

## 1. 무엇을 판정하는가

### 2026-09-13: 단일 조건·반응형 파일럿의 적용 규칙

아래는 현재 단일 조건 입력 감사와 짧은 반응형 대화에 적용한다. 과거 2인 blind calibration 절차와
혼합하지 않는다. 사용자 검수 규칙은 `user-confirmed`, 구현 규칙은 `repo-evidenced`다.

- 합성 이전 assistant 발화를 고정한 시험은 입력·검색 진단이다. 실제 연속 대화 검증이라고 부르지 않는다.
- `conversationDesign.kind: reactive-pilot`은 첫 사용자 메시지만 고정한다. 이후 사용자 발화는 실제
  캐릭터 답변에 반응하고, 모든 이전 실제 답변을 다음 요청에 보존한다. 첫 접촉 시험은 새 격리 관계
  상태로 시작한다. 생성 사용자에게 캐릭터의 비공개 설정·정답·평가 기준을 제공하지 않는다.
- 해당 실행은 `diagnostic` 전용이다. 기존 결과 형식의 `passed: false`는 자동 통과를 부여하지
  않는다는 뜻이며 **사람 FAIL이 아니다**. 자동 점수와 인증 여부를 자연스러움 판정으로 표시하지 않는다.
- 시험 문맥 판정(`contextVerdict`)과 답변 판정(`verdict`)을 따로 보존한다. 문맥 문제라고 해서
  기존 답변 판정을 자동 취소하거나 바꾸지 않으며, 코멘트만으로 PASS/FAIL을 추정하지 않는다.
- 단일 답변 검수는 packet ID, run ID, 답변 ID, 실제 요청 SHA-256이 일치해야 반영한다.
  누락한 답변은 미검수이며, 답변 PASS는 전체 대화 PASS나 이전 버전 대비 우위가 아니다.
- 반응형 대화는 생성에 따라 서로 다른 문맥으로 갈라진다. 동일 문맥 A/B와 구별하며, 단일 조건
  파일럿만으로 개선율·승률을 보고하지 않는다.
- 외부 실행 전에는 제공자 고정·가격 상한뿐 아니라 **캐릭터와 사용자 생성 요청 양쪽의 매개변수**를
  해당 제공자의 지원 목록과 대조한다. 로컬 가짜 모델 성공은 이 계약의 검증이 아니다. 2026-09-13
  실행에서 사용자 생성 요청의 `seed`가 Xiaomi 지원 목록에 없는 결함이 확인됐다. 정확한 원격 오류
  코드는 보존되지 않았으므로 이를 특정 HTTP 오류의 확정 원인으로 기록하지 않는다.
  이후 해당 설정 제외·최신 지원 목록 검사를 적용한 [재승인 실행](../reports/character-chat-reactive-rerun-2026-09-13.md)은
  40회 모두 완료했다. 이 실행 성공은 자연스러움 PASS와 별개다.

단일 답변 부분 검수 집계:

```bash
node --import tsx evals/cli.ts review-injection \
  --key /absolute/path/to/packet.json \
  --source /absolute/path/to/submission.json \
  --output /absolute/path/to/new-review-directory
```

원문과 판정을 보존하는 기존 검수 화면의 패킷을 key로 사용할 수 있다. 이 명령은 모델을 호출하지
않으며 기존 출력 디렉터리를 덮어쓰지 않는다. 새 파일럿의 구현·로컬 검증 근거는
[2026-09-13 재시험 보고서](../reports/character-chat-test-design-retest-2026-09-13.md)에 있다.

판정 질문은 하나다.

> 이 대화가 설정 자료를 말로 재연하는 봇이 아니라, 해당 캐릭터와 실제로 메시지를 주고받는
> 경험에 가까운가?

문장이 짧거나 한국어 문법이 맞는다는 이유만으로 자연스럽다고 판정하지 않는다. 직전 발화에
대한 반응, 사람다운 한국어, 상호성, 캐릭터의 생활감, 설정 소재의 절제까지 함께 본다.

## 2. 검수 단위와 순서

1. **Blind pairwise:** 모델명, 자동 점수, 캐릭터 이름과 A/B 원래 순서를 가린 두 trajectory 중 더
   자연스러운 쪽을 고른다. 차이가 없으면 `tie`, 판단할 수 없으면 `abstain`이다.
2. **Trajectory verdict:** 전체 대화를 `pass`, `fail`, `abstain`, `not-reviewed` 중 하나로 판정한다.
   한두 문장의 유창함보다 대화 전체가 사람의 구조 요청을 요구하는지를 본다.
3. **Turn annotation:** 실패를 입증하는 최소 발췌와 turn 번호, 아래 tag, 구체적 이유를 남긴다.
   실패가 아니라 평가 규칙의 반례이면 `assessment: boundary`, 자동 판정을 명시적으로 뒤집는
   주석이면 `assessment: verdict-override`로 구분한다.
4. **Adjudication:** 두 reviewer가 서로의 판정을 보지 않고 독립 검수한 뒤, 불일치한 항목만 함께
   재검토한다.

같은 reviewer에게 같은 pair를 좌우만 바꿔 다시 보여주지 않는다. 두 명 이상이 독립 blind review를
완료하기 전에는 결과를 `adjudicated`로 표시하지 않는다.

Reviewer에게는 생성된 자신의 `.packet.md`와 `.submission.json`만 전달한다. 이 문서의 아래 실패
예시는 현재 seed와 겹치므로 blind reviewer에게는 정답지 역할을 할 수 있다. 따라서 기존 스모크
원문, 자동 점수, 사람 검수 보고서, calibration seed, `_PRIVATE-review-key.json`, 다른 reviewer의
패킷과 함께 전달하지 않는다. 기존 자료를 이미 본 사람은 이번 표본의 blind reviewer로 세지 않는다.

패킷 생성과 집계 명령은 다음과 같다.

```bash
npm run eval:review:prepare -- \
  --source /absolute/path/to/suite-report.json \
  --output /absolute/path/to/new-review-directory \
  --seed 20260902

npm run eval:review:aggregate -- \
  --key /absolute/path/to/_PRIVATE-review-key.json \
  --submissions /absolute/path/to/reviewer-a.submission.json,/absolute/path/to/reviewer-b.submission.json \
  --output /absolute/path/to/new-agreement-directory
```

집계 결과의 `reviewers-agree`는 두 입력이 일치했다는 뜻일 뿐 `adjudicated`나 `calibrated`가 아니다.
불일치·기권 항목은 별도 합의 검수를 거쳐야 하며 최종 gold 승격은 사람이 명시적으로 승인한다.
두 submission의 `reviewerAlias`는 각각 다른 비식별 가명으로 바꿔야 한다. Tooling은 가명 중복을
막지만 같은 사람이 의도적으로 두 가명을 쓰는 것까지 증명할 수 없으므로 운영자가 독립성을 확인한다.

## 3. 판정 기준

### `local_relevance`

직전 사용자 발화에 직접 반응하고, 새 화제로 넘어갈 때 대화 안에 연결 고리가 있어야 한다.
사용자가 말하지 않은 방문 목적, 현재 상황, 감정이나 행동을 전제로 질문하면 실패다.

- 실패 예: 짧은 인사에 곧바로 날씨를 말하거나 `어디 놀러 왔어요?`라고 묻기
- 실패 예: 아무 유입 맥락 없이 `뭐 보고 오셨어요?`라고 묻기
- 통과 가능: `ㅎㅇ`에 짧게 인사하고 가벼운 기여를 하되, 사용자의 상황을 지어내지 않기

### `natural_korean`

문법뿐 아니라 실제 한국어 채팅에서 쓰일 법한 단어 선택, 어순, 지시 대상과 문장 연결을 본다.
업계 용어를 썼다는 사실만으로 자연스러운 표현이 되지는 않는다.

- 실패 예: `그날이 있죠`처럼 문맥상 `그런 날이 있죠`가 필요한 표현
- 실패 예: 의미가 불명확한 `한 발 빠져서 보고 있어서`
- 실패 예: 번역투·상담형 첫 인사나 지시 대상이 없는 문장

### `persona_without_motif`

Persona는 반응의 관점과 선택에 드러나야 한다. 프로필, 게시물, 상품명, 직업, 취미와 대표 소재를
말했기 때문에 점수를 주지 않는다. 사용자보다 설정 소재가 먼저 나오거나 같은 소재가 대화를
독점하면 실패다.

- 실패 예: 첫 대화에서 수업, 회원, 작업 절차를 연달아 설명하기
- 실패 예: 게시물의 의상명이나 촬영 세부를 상품 설명처럼 재연하기
- 실패 예: 캐릭터의 대표 직업·취미 이야기만 계속하기
- 통과 가능: 설정을 직접 설명하지 않아도 캐릭터다운 반응 선택과 말의 온도가 유지됨

### `mutuality`와 `topic_diversity`

대화를 질문 목록이나 자기소개로 만들지 않고, 사용자 발화에 반응하면서 작은 자기 기여와 여백을
만든다. 질문이 있다는 이유만으로 실패하지 않으며 질문 수가 적다는 이유만으로 통과하지 않는다.
대표 소재 하나가 대화를 반복적으로 장악하면 `topic_diversity`도 표시한다.

### `register_fit`

반말·존댓말 혼용은 전역 오류가 아니다. Persona, 관계 단계, 사용자의 말투, 해당 턴의 의도에 맞으면
허용한다. 관계 변화나 의도 없이 말끝만 기계적으로 흔들려 화자의 태도가 불분명할 때 실패다.

### `world_state_restraint`

현재 활동이나 일정의 정본이 없을 때 구체적인 사실을 이미 확정된 상태처럼 만들지 않는다.
캐릭터가 그런 세부를 말했더라도 simulator나 reviewer가 자연스럽게 받아 주며 결함을 가려서는 안
된다.

## 4. 전체 판정 규칙

- `pass`: 국소적인 사소한 어색함은 있을 수 있지만, 사용자가 전제나 문장을 대신 고쳐 주지 않아도
  대화가 자연스럽게 이어진다.
- `fail`: 근거 없는 전제, 부자연스러운 한국어, 설정 자료 재연, 반복 소재, 상담 응대처럼 느껴지는
  흐름 중 하나 이상이 대화 경험을 실질적으로 깨뜨린다.
- `abstain`: 원문 손상, 언어 판단 불가 등으로 reviewer가 판정할 수 없다.
- `not-reviewed`: 사람이 아직 해당 trajectory를 검수하지 않았다. 자동 판정을 사람 판정처럼
  해석하지 않는다.

명시적인 사람 `pass`/`fail`은 `effectiveVerdict`에서 자동 판정을 덮어쓴다. `abstain`과
`not-reviewed`는 자동 판정을 보존하되 사람 검수 완료로 세지 않는다.

## 5. Seed와 gold의 경계

[`naturalness-human-seed-2026-09-02.json`](../../evals/calibration/naturalness-human-seed-2026-09-02.json)은
자동 결과를 본 한 명의 사후 검수 22개를 구조화한 **seed**다. 자동 PASS 3건을 사람 FAIL로 뒤집은
중요한 false-pass 증거지만 blind review가 아니므로 gold나 release 기준이 아니다.

`adjudicated` 승격 조건은 다음과 같다.

- reviewer 2명 이상
- 서로의 판정과 자동 점수를 보지 않은 독립 blind review
- 불일치 항목 adjudication 완료
- 모든 verdict evidence가 존재하는 transcript와 같은 ID를 참조
- production transcript를 사용하지 않음. 별도 개인정보·동의 정책 승인 전에는 synthetic 또는
  명시적으로 허용된 비식별 fixture만 사용

## 6. 보고 항목

보정 실행은 최소한 다음을 별도로 보고한다.

- 자동 judge와 adjudicated human의 agreement
- 자동 `pass` / 사람 `fail`인 false-pass
- 자동 `fail` / 사람 `pass`인 false-fail
- reviewer 간 agreement와 주요 불일치 원인
- tag별 실패 수와 대표 turn evidence
- 유지·수정·폐기할 judge 기준

agreement가 낮으면 평균 점수로 감추거나 threshold를 낮춰 통과시키지 않는다. 그 경우 결론은
“현재 judge를 품질 gate로 신뢰할 수 없음”이다.
