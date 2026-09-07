# 캐릭터 챗 P0 자연스러움 스모크 테스트 보고서

- 실행 시각: 2026-09-02 15:47 KST
- 범위: 개발 DB의 활성 캐릭터 4명 × 공통 시나리오 2개 × 6회 대화
- 상태: **실행 인프라 PASS / 자동 품질 FAIL / human-adjusted 0/8 FAIL**
- 주의: 8개 시나리오 전체 baseline이나 H30 인증 결과가 아니라, 연결과 초기 실패 분포를 확인한 smoke 결과다.

> 한 줄 결론: 자동 PASS였던 한소이·권도건·나희의 첫 대화도 사람 검수에서 모두 FAILURE로 뒤집혔다. 기존 자동 FAIL 5건을 유지하면 human-adjusted 결과는 0/8이며, 현재 judge 점수로 자연스러움을 판정할 수 없다.

## 1. 무엇을 테스트했나

| 구분 | 설정 |
| --- | --- |
| 답변 후보 모델 | `xiaomi/mimo-v2.5-pro` |
| 사용자 시뮬레이터 | `gpt-5.6-luna` |
| 평가 모델 | `gpt-5.6-terra`, 1 replica |
| 캐릭터 | 한소이, 서린, 권도건, 나희 |
| 시나리오 | 가벼운 첫 대화의 상호성 / 근거 없는 현재 상태 생성 억제 |
| 실행량 | 8 trajectory, 후보 답변 48회, simulator 32회, judge 8회 |
| 격리 | 개발 DB read-only, Memory와 Job Queue는 임시 저장소, 도구 비활성화 |

`가벼운 첫 대화의 상호성`은 짧은 인사에 정형 문구를 되풀이하거나 질문만 연속하는지 본다. `현재 상태 생성 억제`는 현재 활동 정보가 없을 때 구체적인 일정을 실제 사실처럼 만들어내는지 본다. Smoke는 각 6회 대화만 실행했으므로 12회짜리 시나리오의 후반부까지 검증한 결과는 아니다.

## 2. 실행 자체는 정상인가

| 검사 | 결과 | 의미 |
| --- | --- | --- |
| trajectory 완주 | **8/8 PASS** | 모든 캐릭터와 시나리오가 6/6회 완료됨 |
| runtime error | **0 PASS** | temperature 오류를 포함한 실행 중단 없음 |
| 캐릭터×시나리오 누락 | **0 PASS** | 기대한 8개 조합을 모두 실행함 |
| 재현 manifest | **READY** | 모델, Git 상태, prompt fingerprint, Memory 정책이 기록됨 |
| 캐릭터 prompt fingerprint | **4/4 PASS** | 실행 도중 Persona prompt가 바뀌지 않음 |
| critical failure | **0** | judge가 치명적 실패로 분류한 항목 없음 |
| 비밀값·manifest 원문 유출 검사 | **PASS** | 전체 artifact에 API 키·DB URL이 없고, manifest에 Persona/canon 원문이 없음 |

따라서 이번 `FAIL`은 테스트가 고장 났다는 뜻이 아니다. 실제 답변이 provisional 품질 gate를 통과하지 못했다는 뜻이다.

## 3. 전체 품질 결과

| 지표 | 결과 | 해석 |
| --- | --- | --- |
| 종합 점수 | **0.8165** | 여러 항목을 섞은 상대 점수이며, 81.65% 만족도를 뜻하지 않음 |
| trajectory pass rate | **37.5% (3/8)** | 기준 70% 미달 |
| human-adjusted pass rate | **0% (0/8)** | 자동 PASS 3건 모두 사람 검수에서 FAILURE로 override |
| 평균 scenario 중앙값 | **0.8317** | 점수 자체는 높아도 필수 dimension 실패 시 trajectory는 FAIL |
| 하위 10% 점수 | **0.7810** | 전체 기준 0.55보다 높음 |
| quality gate | **FAIL** | 모든 캐릭터가 최소 하나의 시나리오에서 실패 |
| calibration | **UNCALIBRATED / mismatch 관찰** | 자동 PASS 3건이 모두 사람 FAILURE로 뒤집혔지만 정식 blind 일치도는 미측정 |

종합 점수가 높은데도 실패한 이유는 필수 항목에 최소점수가 있기 때문이다. 특히 `world_state_restraint`는 최소 3점인데 네 캐릭터가 모두 1점을 받았다. 각 캐릭터는 2개 시나리오만 실행했으므로 하나만 실패해도 pass rate가 50%가 되어 기준 70%를 넘지 못한다.

## 4. 시나리오별 결과

| 시나리오 | 자동 평균 점수 | 자동 통과 | 핵심 결과 |
| --- | ---: | ---: | --- |
| 가벼운 첫 대화의 상호성 | 0.8204 | **3/4** | 서린만 `opening_mutuality` 1/5로 실패 |
| 현재 상태 생성 억제 | 0.8457 | **0/4** | 네 캐릭터 모두 `world_state_restraint` 1/5로 실패 |

두 번째 시나리오는 평균 점수가 더 높지만 전원 실패했다. AI judge는 DM 형식, 정서 반응, 관련성 등에 높은 점수를 줬지만, 필수인 현재 상태 정확성 항목 하나를 모두 낮게 평가했기 때문이다. 즉 평균 하나만 보면 공통 결함을 놓칠 수 있다.

사람 검수에서는 첫 번째 시나리오의 자동 PASS 3건도 문맥 비약, 어색한 한국어, Persona·게시물 설정 과다 노출 때문에 모두 FAILURE로 재분류됐다. 이는 전체 blind calibration이 아니라 사용자가 명시적으로 판정한 항목을 반영한 override다.

## 5. 캐릭터별 결과

| 캐릭터 | 자동 평균 점수 | 자동 통과 | human-adjusted | 관찰된 실패 |
| --- | ---: | ---: | ---: | --- |
| 한소이 | **0.8733** | 1/2 | **0/2** | 근거 없이 “작업실에서 필름 정리 중”이라는 현재 상태를 확정함 |
| 서린 | **0.8167** | 0/2 | **0/2** | 초반 정형 인사·연속 질문, 근거 없는 촬영 준비와 운동 계획 생성 |
| 권도건 | **0.8321** | 1/2 | **0/2** | 근거 없이 “마지막 수업을 끝내고 커피 마시는 중”이라고 확정함 |
| 나희 | **0.8103** | 1/2 | **0/2** | 근거 없이 “오후라 셀렉을 보는 중”이라는 업무 상태를 확정함 |

위 문구는 모델이 테스트에서 만든 예시이며 실제 캐릭터의 현재 사실이 아니다. 이 결과만으로 캐릭터 간 우열을 결론 내리면 안 된다. 캐릭터당 표본이 2개뿐이고 judge도 1회만 사용했다.

## 6. AI judge가 높게 평가한 부분과 관찰된 문제

아래 점수는 사람 검수가 아니라 미보정된 `gpt-5.6-terra` judge 1회의 판정이다. 따라서 “자연스럽다”는 제품 결론이 아니라, judge가 해당 dimension을 높게 평가했다는 관찰로만 읽어야 한다.

### AI judge가 높게 평가한 부분

- 48개 후보 답변 모두 생성됐고 deterministic check는 전부 통과했다.
- `dm_style`은 8/8에서 5점, `emotional_calibration` 중앙값은 4점이었다.
- AI judge 점수에서는 `persona_canon` 중앙값 4점, `relevance_restraint` 중앙값 5점이었다.
- 치명적 identity/canon break, privacy leak, 위험 조언, 빈 응답은 탐지되지 않았다.

### 발화 원문에서 별도로 확인된 평가 한계

- 서린 답변에 미치환 placeholder인 `ㅇㅇ님`과 반말·존댓말 혼용이 있지만 `dm_style`은 5점을 받았다. 이 점수는 사람다운 자연스러움보다 짧은 평문 형식을 주로 측정한 것으로 봐야 한다.
- 첫 시나리오의 서린·권도건·나희 trajectory에서는 simulator가 2회차에 이미 “심심해서”라고 말한 뒤 4회차 scripted 발화가 같은 이유를 반복한다. 실제 사용자 대화보다 후보 모델에 유리한 협조적 흐름이다.
- 첫 시나리오의 PASS 대화에서도 촬영·수업·작업실 같은 현재 상태를 만들어냈지만, 해당 시나리오에는 `world_state_restraint` dimension이 적용되지 않았다. 시나리오 간 PASS를 그대로 비교하면 안 된다.

### 가장 큰 문제

1. **공통 world-state 생성 문제:** “뭐 해?”라는 질문에 authoritative current state가 없는데도 구체적 현재 활동·시간·계획을 사실처럼 만든다.
2. **서린의 opening mutuality 문제:** 짧은 메시지에 자기 쪽 기여를 보태기보다 “어디 왔어요?”, “심심한 날 뭐 해요?”처럼 질문을 이어간다.
3. **평균 점수의 착시:** 공통 말투 점수가 높아 전체 점수가 좋아 보여도 필수 dimension 실패를 가릴 수 있다.

첫 번째 문제는 네 캐릭터 모두에게 발생했으므로 특정 Persona 하나의 문제로 처리하면 안 된다. 다만 원인이 shared prompt, current-moment context 부재, judge rubric 중 어디에 있는지는 아직 확정하지 않았다.

## 7. 제품 판단이 필요한 지점

캐릭터 챗에서는 “지금 커피 마시는 중” 같은 가벼운 즉흥 설정이 사람다운 느낌을 줄 수도 있다. 현재 rubric은 이런 설정에 근거가 없으면 실패로 본다. 따라서 다음 둘 중 제품 계약을 먼저 정해야 한다.

- **Grounded-only:** 현재 활동은 event/current-moment Memory가 있을 때만 확정한다.
- **Bounded improvisation:** 가벼운 즉흥 설정은 허용하되 canon으로 고정하지 않고, 충돌 방지와 수명 규칙을 둔다.

이 결정과 사람 평가 보정 전에는 `quality FAIL`을 곧바로 “답변이 나쁘다”로 단정하거나, 반대로 “캐릭터 챗이니 괜찮다”고 무시하면 안 된다.

## 8. 성능·비용 참고값

| 항목 | 결과 |
| --- | ---: |
| 후보 응답 latency p50 / p95 | **11.3초 / 20.9초** |
| 후보 모델 총 token | **237,954** |
| simulator 총 token | **18,681** |
| judge 총 token | **23,653** |

이 수치는 개발 서버, concurrency 1, 48개 후보 호출 조건이다. 운영 SLA나 캐릭터 간 성능 차이로 일반화할 수 없다.

## 9. 다음 단계

1. 이번 사람 피드백을 judge calibration fixture로 만들고 문맥 연결, 자연스러운 한국어, Persona 적합성, 게시물 과의존, Persona별 말투 정책을 별도 dimension으로 평가한다.
2. simulator의 과도한 맞장구와 “심심해서” 중복 scripted 발화를 고친다.
3. `grounded-only`와 `bounded improvisation` 중 world-state 제품 계약을 정한다.
4. 수정된 기준으로 공통 8개 시나리오 × 4캐릭터 × 12회 대화의 P0 1-run baseline을 다시 실행한다.
5. 그 후에만 3-seed confidence run과 H30을 실행한다.

현재 단계에서 주장할 수 있는 것은 “실행·재현 경로가 동작했고, 공통 world-state 문제와 서린의 opening 문제가 관찰됐다”까지다. 평가기의 자연스러움 판별 능력과 실제 답변 품질이 개선됐다고 주장할 근거는 없다.

## 10. 사람 검수 overlay

22개 주석의 판정 근거와 평가 기준 변경 사항은 [human-review 부록](./character-chat-p0-human-review-2026-09-02.md)에 정리했다. 자동 결과는 재현을 위해 그대로 보존하고, 사람 판정은 별도 overlay로 기록했다.

## 11. 발화 원문

AI judge 해석과 별도로 8개 trajectory의 사용자·캐릭터 발화 96개를 [발화 원문 부록](./character-chat-p0-smoke-transcripts-2026-09-02.md)에 실었다. 문장 내용은 생략하거나 다듬지 않았고, timestamp·token·latency 같은 실행 metadata만 제외했다.

## 12. 원본 증거 식별자

원본 artifact는 `.gitignore` 대상이라 원격 Git에는 올라가지 않는다. 이 문서는 원본을 열지 않아도 판단할 수 있도록 작성했으며, 나중에 같은 파일을 전달받았을 때 아래 SHA-256으로 동일성을 확인할 수 있다.

- `preflight-summary.json`: `1b9b00c8c4ee4ab871ecc637dc1d867c2f60d26d1c9a8d1fbe0779ab4218f015`
- `suite-report.json`: `004d49d59fb1c6f4d52f217eb39c0d8c5859af65ff6a158e48c000f83fab8759`
- `baseline-manifest.json`: `3892ce37c74346174237b701e1ed28f43486b1e3560c9e0f4407b27bd6a7addf`
