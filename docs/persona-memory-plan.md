# 페르소나·메모리 적용 전략 (2026-07-21 확정)

opod-admin 파이프라인에서 확정된 페르소나(표준 블록 12종)와 캐릭터 메모리(세계관 +
게시 역반영)를 opod-agent 채팅에 적용하는 전략. 코드·스키마 조사 결과와 단계별
결정을 기록한다.

> 2026-09-07: 자연스러움 개선의 현재 실험 계획은
> [`Persona·Memory 연구 문서`](character-chat-products-persona-memory-research-2026-09-03.md) 10~11절이다.
> 아래 7월 단계 기록은 구현 이력이며 전체를 새로 구현할 목록이 아니다. 새 정책·DDL은 별도 결정한다.

## 2026-09-12 작성 항목의 역할 정리

로컬 4개 캐릭터의 중복 정리 후속이다. 작성 시 같은 문장을 여러 항목에 복사하지 않고 아래
담당 위치를 우선한다. 제목은 작성 규약이며 런타임은 제목이 아니라 `kind`와 `injection`을 읽는다.
새 DB enum·필수 항목·UI 제약을 도입했다는 뜻은 아니다. 캐릭터별 항목 개수를 강제로 맞추지 않는다.

| 작성 위치 | 담당 내용 | 넣지 않는 내용 | 현재 로컬 주입 |
| --- | --- | --- | --- |
| identity | 이름·나이/생일·직업·핵심 정체성 | 성격 평가, 장황한 외형, 첫 인사 | identity / always |
| personality | 기질·약점·판단·자기 인식·내적 감정 | 말끝/이모지, 특정 사용자와 이미 겪었다는 사건 | behavior / always |
| values (필요할 때) | 중요한 가치와 선택 기준 | 생활 사실, 다른 항목에 이미 적힌 판단의 반복 | behavior / always |
| social_style | 칭찬·갈등·위로·친숙함에 대한 캐릭터별 반응 | 실제 사용자와의 현재 친밀도를 고정하는 문장, 해요체 규칙의 복사 | behavior / always |
| voice | 존댓말/반말 조건·문장 감각·농담·웃음·이모지 | 직업 설명, 현재 활동, 공통 채팅 정책의 복사 | voice / always |
| boundaries | 사생활·동의·접근 범위·안전 경계 | 현재 위치·개인 연락처, 예시 대화 속 약속을 실제 관계로 간주 | behavior / always |
| appearance/world/relationships/preferences/goals | 고정 외형·배경·인물관계·취향·장기 목표의 작성 원문 | 지금 하고 있는 일이나 특정 사용자와의 경험을 추정 | lore / never_prompt 원문, 필요한 사실은 별도 canon 검색 |
| content_style | 게시물·사진·캡션·공개 댓글 제작 규칙 | DM의 성격·말투를 지시하는 문장 | creator_note / never_prompt |

`relationships`의 가족·동료 설정과 `social_style`의 대인 반응, 사용자별 실제 관계 상태는 서로
다른 정보다. 작성 원문과 canon이 같은 사실을 담을 때 source_refs는 출처이며 두 번 주입하라는
지시가 아니다. 원문만 편집해 canon 내용/출처가 달라지면 함께 검토해야 한다. 검색에 들어갈 사실을
never_prompt 원문에만 남긴 채 이관됐다고 가정하지 않는다.

공통 대화 규칙은 `src/chat/system-prompt.ts`의 `CONVERSATION_CHANNEL`과
`NATURAL_REPLY_POLICY`가 이미 담당한다. 답변 길이 조절, 질문 강요 금지, 배경을 화제로 강요하지
않기, 현재 행동 날조 금지, 지문 금지 등 기존 owner가 실제로 제공하는 규칙만 이번에 중복 제거했다.
공통 owner에 없는 사생활·안전 규칙까지 임의로 삭제하거나 새로운 전역 정책으로 바꾸지 않았다.

현재 상황은 제공된 대화 문맥·확인된 정보에서 읽으며 평소 루틴을 현재 행동으로 간주하지 않는다.
첫 인사와 예시는 필요하면 별도 authored 역할로 다루되, 사용자 미검수 예시를 좋은 답변으로
확정하거나 실제 사용자 기억에 넣지 않는다.

검증된 로컬 상태: 활성 persona40 / 상시22 / canon125. 마지막 역할 정리는17개 블록을 변경하고
25문장을 원문 그대로 이동했으며, 기존 공통 정책 등과 겹치는16곳을 줄였다. 항목이나 기억을
추가 삭제하지 않았다. 상시 본문 합계는14,546→13,334 UTF-8바이트이며 실제 생성 품질 수치가 아니다.
자세한 증거와 제한은 [분류 정리 보고서](reports/persona-classification-and-dedup-2026-09-12.md)의
후속 절을 참조한다. 아래 9월11일 및 7월 수치는 해당 시점의 이력이다.

## 2026-09-11 통합 문맥 경로 — 로컬 검증 완료

이 절은 아래 과거 상태표보다 우선한다(`repo-evidenced`).
사용자의 “DDL 포함 진행” 계약에 따라 전용 로컬 DB55433에 추가형 migration
`20260911063302_character_chat_context`를 적용했다. 개발 DB/배포/외부 모델 호출은 하지 않았다.

- **호환 모드:** 기본은 `CHARACTER_CONTEXT_MODE=legacy`. `integrated`에서만 새 혼합 검색,
  출처형 기억, 입력 예산을 사용한다. 되돌릴 때 모드를 바꾸며 컬럼이나 데이터를 삭제하지 않는다.
  새 reader/admin은 migration 적용 후 사용한다.
- **검색 소유자:** `PostgresPersonaStore.retrieveContext`와 `PostgresMemoryStore.retrieveWithTrace`.
  캐릭터 또는 사용자+캐릭터 범위를 SQL에서 먼저 제한하고 전체 범위의 어휘/벡터 후보를 각각
  찾은 뒤 결합한다. 최근512개만 먼저 고르는 제약은 새 경로에 없다. RRF·관련성 문턱·중복 제외는
  후보 선택 규칙일 뿐 한국어 의미 검색 품질을 입증하지 않는다.
- **벡터 신뢰:** 모델·원문 SHA-256·1024차원·유한수 조건을 검사한다. source 변경/모델 불명인
  벡터는 의미 검색에서 제외한다. 의미 검색 실패는 어휘 검색으로 축소하고 trace에 실패를 남긴다.
  현재 제품의 동적 Provider 모델 식별을 추정하지 않아 integrated 기본 연결은 **어휘 검색만** 한다.
  고정 Provider를 검증한 실험에서만 `ChatService`/Consolidation의 `embeddingModel`을 지정한다.
  실제 캐릭터/기억 벡터를 채우지 않았으며 전용 DB의 벡터0건은 정상적인 후속 대기 상태다.
- **자료 대응:** projection ID와 DB fragment ID는 다르다. `storedFragmentId` 및 검색 source hash로
  주입 직전에 원문 일치를 확인한다. 캐릭터의 사실과 사용자 사실은 같은 문장이어도 합치지 않는다.
  기억 유형(user_fact/shared_episode/interpretation)도 중복 제거 때 구별한다.
- **직전 문맥:** `contextRecallQuery`는 짧은 지시/후속 발화일 때 직전 user/assistant 구간을 검색에
  포함한다. 명시적 주제 전환은 새 주제만 사용한다. 이는 제한적인 규칙이며 일반 의도 분석기가 아니다.
- **주입 예산:** `context-budget.ts`는 메시지 전체+고정 요청/도구 정의의 UTF-8 바이트를 계산한다.
  `CONTEXT_MAX_BYTES` 기본32,000. 토큰 제한이라고 부르지 않는다. 낮은 우선순위의 선택 자료부터
  통째로 빼며 원문 메시지는 자르지 않는다. 필수 내용만으로 초과하면 생성 요청 전에 명시적 오류다.
  이후 tool-loop가 만든 추가 결과 전체의 예산 관리까지 구현한 것은 아니다.
  요약은 요청 원문이 이미 그 범위를 모두 포함할 때만 생략한다. Core의 대화 방식 합의를 단순한
  검색어 불일치로 버리지 않으며, 기존 Core는 출처 미검증 요약이라고 표시한다.
- **기억 쓰기:** `parseObservations`/`ConsolidationService`가 sourceIndices를 실제 job 메시지와
  대조하여 role/content/절대 위치/hash를 만든다. 사용자 사실에 assistant 근거가 들어가면 거부한다.
  사건 시각을 모르면 NULL, 기존 metadata도 추정하지 않는다. 잘못된 batch는 저장·요약 진전 전에
  실패한다. 기존 operation_key/ordinal 및 summary CAS를 유지한다. Reflection은 interpretation이며
  원문 근거를 보존할 수 없는 평문 Core 자동 재작성은 integrated에서 생략한다.
- **색인 실행:** `evals/context-index-cli.ts`는 로컬55433만 허용하고 원문 hash CAS로 저장한다.
  기본 dry-run; 실행에는 별도 모델/전송 계약과 `--execute`가 필요하다. 요청·행·바이트 한도는
  있으나 가격별 금액 제한은 아직 없으므로 **후속 비용 계약 전 실행 금지**다.

네 캐릭터의 저장 내용은 원문45개·canon79개 모두 보존했다. 과하게 묶인 배경4개만 관리 API로
분리해 조각78→86개로 만들었다. 성격·말투·안전 경계는 그대로이며, 이미 제외돼 있던 게시물 제작
지침을 이번에 새로 제거했다고 주장하지 않는다. 같은 질문4개에서 고정 character prompt hash는
그대로이고 전체 입력은 각각228/364/326/306bytes 줄었다. **답변 자연스러움 개선 증거는 아니다.**

검증 위치: `src/chat/character-context.integration.test.ts`, persona/archival/grounding/budget tests,
`evals/context-index-cli.test.ts`, `evals/target.test.ts`. 실제 일회용 PostgreSQL에서 기준/통합 경로,
격리, 기억 저장·재연결·재시도를 검사한다. `evals/cases/character-context-integration.json`은 합성
구조 사례이며 12턴 실제 모델 평가를 실행한 기록이 아니다. 사용자 검수의 미검수·선호·기권은
그대로 유지한다. 정정/망각 및 실제 한국어 embedding/대화 사용자 검수는 후속이다.

## 과거 상태 (2026-07-21 조사, 2026-09-07 상태 갱신)

| 영역 | 상태 |
| --- | --- |
| 페르소나 블록 주입 | raw read 완료. P1-1은 ID 기반 explicit routing read model을 구현했지만 실제 DB 매핑은 아직 미활성 (ADR-0002/0008) |
| DM 연동 | 완료 — service-backend `sendMessage` → `OPOD_AGENT_URL` (OpenAI 호환 + `X-Opod-*` 헤더) |
| 캐릭터 메모리 주입 | C1에서 ID·type·reason·등록/수정 시각을 가진 레코드로 읽도록 개선. 프롬프트에는 기존과 같은 원문을 전량 주입하며 relevance·유효성 정책은 아직 미변경 |
| 관계 메모리 (유저별 Archival/Core/Summary) | Postgres 지속화 구현 완료(Phase 3). DB 미설정 시 stub 사용 |
| Consolidation 실행 | Postgres queue와 프로세스 내 worker 구현 완료(Phase 4). 실행 여부는 환경 설정에 따름 |

## 기능·동작 정의

- **캐릭터 정체성**: 매 턴 시스템 프롬프트에는 이름/bio + `always` 블록 +
  세계관 메모리(canon, 모순 금지)가 들어간다. `start_only`와 선택된
  `retrieved` 블록은 해당 턴의 tail context, `never_prompt`는 미주입한다.
  명시적 매핑이 없는 Store는 배포 호환성을 위해 기존 전량 주입 동작을 유지한다.
- **최근 근황**: 게시 역반영 메모리(`reason` = `auto:` 접두)는 여전히
  `character_canon_memories`로 흘러들어 전량 주입된다. P1-1은 Persona block만 다루므로
  이 경로의 relevance·수명 문제는 해결되지 않았다.
- **유저별 관계 기억**: 관찰(중요도 채점) → 중요도 누적 → 성찰 → Core
  자기갱신 구조 (Generative Agents + MemGPT, ADR-0005). 저장 지속화는 완료했고,
  검색 관련성·정정·망각·유효성의 품질 검증은 별도 과제다.

### 2026-09-07 저장 입구와 캐릭터 기억 읽기 계약

아래는 로컬 구현·회귀 검사로 확인한 계약(`repo-evidenced`)이며 서비스 배포 완료 기록이 아니다.

- `parseObservations`는 완전한 JSON 배열 또는 단일 코드펜스의 배열만 받는다. 각 항목은
  비어 있지 않은 문자열과 1~10 정수 중요도가 필요하다. 설명문·잘못된 항목을 기본 중요도와
  함께 사실로 보정하지 않는다. 잘못된 batch는 저장 전 실패하고 `[]`는 정상적인 기억 없음이다.
- `completeText`는 정상 종료된 문자열 응답만 반환한다. 잘린 응답·거절·도구 호출·응답 누락은
  원문 없는 오류로 처리한다. 추출 실패 시 Summary 진전과 importance 증가가 없고 같은 job의
  정상 재시도에서 한 번만 저장된다. 별도 모델 복구 호출은 추가하지 않았다.
- Reflection은 공급된 evidence에 실제 존재하는 번호를 명시해야 한다. 인용 누락/범위 오류가
  있는 합성 batch는 Archival 저장과 Core 입력 전에 거부한다. 이는 **인용의 구조적 유효성**이며
  올바른 번호가 붙은 주장의 의미적 사실성까지 보장하지 않는다.
- `PostgresPersonaStore`는 character canon의 기존 `id/type/content/reason/created_at/updated_at`을
  읽는다. `Persona.canonMemories`는 이 구조화된 레코드와 기존 string 입력을 모두 지원한다.
  DB 시각은 정밀도를 잃지 않는 원문 문자열이며 **사건 시각·만료 시각이 아니다**. type/reason으로
  중요도·current state·routing을 자동 추론하지 않는다.
- `assembleSystemPrompt`는 구조화된 canon에서도 content만 기존 순서로 렌더링한다. ID·reason·
  시각은 모델 prompt에 추가하지 않는다. 실제 4명/79건 snapshot에서 이전 prompt와 byte 동일성을
  확인했고, 별도 실제 로컬 DB 테스트에서 미세 시각 순서·soft delete·캐릭터 격리를 검증했다.

기억 정정/망각 API, 파생 Core/Summary/history/대기 job의 재유입 방지, 관련성 선택은 아직
구현·검증되지 않았다. 위 계약을 G4 완료나 자연스러움 향상으로 표현하지 않는다.

### 2026-09-08 겹치는 요약 작업의 범위 계약

- 새 `ChatService` 작업은 `turnsStartOffset`을 함께 기록한다. 단위는 해당 세션의 user/assistant
  **메시지 개수**이며 0부터 시작한다. 왕복 수나 텍스트 줄 수가 아니다. 기존 job의 JSON payload에
  들어가므로 DB schema는 바뀌지 않는다.
- `ConsolidationService.refreshSummary`는 실행 시점의 `turnsCovered` 이후 부분만 요약하고,
  source 범위의 끝까지 watermark를 이동한다. 서로 다른 job의 겹치는 길이를 단순 합산하지 않는다.
  이미 모두 처리된 범위는 요약 모델을 다시 호출하지 않는다. 알려지지 않은 앞 구간이 있으면
  요약 단계가 실패하며, CAS 충돌 후에는 최신 watermark를 기준으로 남은 부분을 다시 계산한다.
- 이 범위 처리는 **Summary에만** 적용된다. observation 추출·성찰에 대한 정정/망각 장벽이 아니다.
  `turnsStartOffset`이 없는 과거/수동 job은 기존 동작을 유지하며, 이미 틀어진 Summary를 자동으로
  삭제하거나 재작성하지 않는다. 적용 전 기존 job/요약 상태를 별도로 확인해야 한다.
- 평가 target도 delayed batch의 모든 job을 처리한다. 겹치는 job을 평가에서만 생략하던 우회는
  제거했다. `consolidationQueuePolicy=all_jobs_with_source_ranges_v1`으로 실행 조건을 구분하며,
  과거 batched 결과와 비용·품질을 같은 조건으로 합산하지 않는다.

근거: [M2 재현·회귀 보고서](reports/character-chat-summary-coverage-2026-09-08.md).
현재 계약은 코드와 실제 로컬 DB 검사에 근거한 `repo-evidenced` 지식이며 미배포 상태다.

### 2026-09-08 빈/초과 파생 기억의 저장 계약

- Summary의 모델 응답이 공백뿐이면 요약 단계가 실패한다. 기존 내용, `turnsCovered`, revision과
  멱등 원장은 전진시키지 않으므로 같은 job의 정상 재시도에서 원문을 반영할 수 있다.
- Core 재작성은 trim 후 비어 있거나 `coreCharLimit`을 초과하면 실패한다. 문장 중간을 잘라
  저장하지 않고 기존 Core를 보존한다. 정확히 한도인 내용은 그대로 저장한다. 한도의 단위는
  기존 TypeScript 문자열 길이(UTF-16 code unit)이며 토큰 수나 사용자 인지 글자 수가 아니다.
- `ConsolidationService`는 해당 성찰 실패에서 소비한 예산을 복구한다. 정상 재시도는 기존
  observation/reflection 저장의 멱등 키를 재사용한다. 이전 단계의 유효한 기억을 rollback하는
  변경은 아니며 빈 성찰 결과는 계속 합법이다. 단계별 실패를 공통 함수의 일괄 빈 값 금지로
  대체하지 않는다.

근거: [M3·최신 전체 검사와 잔여 경계](reports/character-chat-completion-boundary-2026-09-08.md).
이는 확인된 저장 계약(`repo-evidenced`)이며 의미적 품질 판정이나 정정/망각 완료가 아니다.

## 단계별 상태

### 2026-09-08 직접 대화 지침 계약

사용자 요청으로 정정·망각/신규 DDL은 후순위다. 공통 답변 지침의 충돌을 먼저 수정했다.
친밀도는 화제·질문·반말·과거 관계를 강제하지 않고, 시계는 날씨/현재 일정의 증거가 아니다.
예시 대화와 게시물 제작 지침은 실제 DM/현재 활동과 구분하며, reflection은 확인되지 않은
추론으로 표시한다. 최근 실제 대화의 의미를 우선하고 캐릭터 의견·반응은 유지한다.
고정 1~2문장 제약은 제거했다. 말투 혼용의 적합성은 Persona와 대화에 따른다.

이는 공통 prompt 사용 계약(`repo-evidenced`)이며 DB source, canon 전량 주입, Router,
기억 검색·저장과 XP 정책은 그대로다. 지침 수정이 한국어 자연스러움의 실제 향상을 입증하지는 않는다.
근거: [N1 수정·검증 보고서](reports/character-chat-direct-naturalness-2026-09-08.md).

### Phase 1 — 근황/세계관 주입 분리: **보류**

`auto:` 역반영이 canon과 동일하게 전량 주입되는 현 구조를 유지한다.
당시에는 데이터 규모를 재검토 기준으로 삼았다. 현재 자연스러움 실험에서는 적은 데이터에서도
과거 사건의 현재화·무관한 소재 반복이 있는지 조사하며, 건수만으로 품질 문제 유무를 판정하지 않는다.

**당시 적용 변경 재검토 트리거**: `auto:` 메모리 30개 초과 관측 시. 그때 운영자 세계관(전량
canon) / `auto:` 역반영(최근 N개만 "최근 근황" 섹션) 분리 + LLM 선별을 도입.
메모리 전체 100개 초과 시 pgvector 하이브리드 검토(기존 확정 결정).
이 수량 기준을 P1의 격리 원인 조사 선행 조건으로 삼지 않는다. 조사 결과가 나오기 전에
전량 canon 정책을 바꾸거나 위 분리 방식·인덱스를 자동 채택하지 않는다.

### Phase 2 — 첫인사 + 호감도 게이트: **TODO (설계만 확정)**

첫인사 블록은 **호감도가 높은 유저에게만** 캐릭터가 먼저 보내는 메시지로 쓴다.

- 트리거: 유저가 DM 화면을 열 때 대화방이 없으면 → 호감도 ≥ 임계값 &&
  첫인사 블록 존재 → 대화방 생성 + 첫인사 블록 원문을 캐릭터 메시지로 삽입
  (LLM 호출 없음, 1회만). 호감도 미달이면 아무 일도 없음(기존 플로우).
- 구현 위치: service-backend. 명시적 "대화방 진입" 엔드포인트 신설 권장
  (GET 부수효과 회피, 앱이 노출 시점 제어).
- 호감도(신규 개념): 새 테이블 없이 기존 신호로 읽기 전용 계산.
  `AffinityService.scoreFor(userId, characterId)`로 분리해 재사용 대비.
  - 초안 산식: 팔로우 중 +30 (7일 이상 +10) · 게시글 반응 개당 +5(상한 30) ·
    댓글 개당 +10(상한 30), 임계값 60. 산식/임계값은 admin_settings로 조정.

### Phase 3 — 관계 메모리 지속화: **구현 완료 (2026-07-21)**

목표: 인메모리 stub인 유저별 관계 기억을 Postgres로 영속화 — 재시작 후에도
캐릭터가 유저를 기억한다.

구현 결정 (원안에서 조정된 것):

- **pgvector 미도입** — 로컬/운영 Postgres의 확장 가용성이 불확실하고 관계당
  메모리 수가 작아, embedding은 `double precision[]` 컬럼 + 앱 내
  `rankByRetrievalScore` 랭킹(후보 상한 512)으로 시작. 관계당 메모리가 수백을
  넘는 게 관측되면 pgvector 후보 축소를 도입한다(관측-후-전환 원칙).
- 멱등 원장 테이블 `chat_applied_state_changes` 추가 (importance/summary
  쓰기 공용) — 총 6테이블.
- E2E 검증 완료: 대화 → 관찰 2건+요약 저장 → 프로세스 재시작 → 새 세션에서
  회상 성공.

**스키마 (opod-service-backend Drizzle, 확장 불필요)** — 코드 계약
(`memory/types.ts`, `memory-store.ts`, `job-queue.ts`)을 그대로 매핑한 6테이블
(마이그레이션 `agent_relationship_memory` + `agent_memory_job_relationship`):

| 테이블 | 내용 | 핵심 제약 |
| --- | --- | --- |
| `chat_memory_entries` | 관찰/성찰 스트림: `memory_text`, `derivation_type`, `importance_score`, `memory_embedding`, `supporting_memory_ids`, `context_injection_mode` | `(user, character, last_recalled_at)`·`(user, character, derivation_type, created_at)` 인덱스; 쓰기 멱등용 `(user, character, write_operation_key, write_batch_index)` 유니크 |
| `chat_memory_session_summaries` | 세션 요약: `summary_text`, `summarized_message_count`, `revision_number` | `(user, character, session)` PK; revision 조건부 원자 쓰기(CAS) |
| `chat_relationship_states` | 성찰 트리거 누적치 `unreflected_importance_score`와 유대 상태 | `(user_id, character_id)` PK; consume은 단일 `UPDATE … RETURNING` |
| `chat_applied_state_changes` | importance/summary/relationship 멱등 쓰기 원장 | `(user, character, idempotency_key)` 유니크 |
| `chat_memory_consolidation_jobs` | consolidation 잡 큐 (`user_id`, `character_id`, `consolidation_request`, `processing_status`, lease) | `idempotency_key` 유니크; `FOR UPDATE SKIP LOCKED` 클레임 |

- embedding 차원은 `EMBEDDING_MODEL`에 고정됨(text-embedding-3-small=1536).
  모델 교체 = 차원 변경 = 재임베딩이므로 모델과 차원을 함께 바꿀 것.

**Agent 어댑터 (`PostgresMemoryStore` / `PostgresJobQueue`)**:

- `retrieve`: 관계의 최근 접근 순 후보 최대 512행을 읽어 순수 함수
  `rankByRetrievalScore`(recency·importance·relevance 가중)로 top-K 랭킹 →
  `last_accessed_at` touch. 벡터 연산은 전부 앱에서 수행 (pgvector 미도입 —
  위 결정 참조; 도입 시 이 후보 조회만 벡터 인덱스로 교체하면 된다).
- `upsertMany`/`saveCoreMemory`/`addImportance`: operation_key 멱등 (재시도가
  확률적 배치를 두 번 적용하지 않게 원본 결과 반환).
- `consumeReflectionBudget`: 원자적 compare-and-consume (동시 잡 2개가 같은
  임계값을 둘 다 넘지 못하게) — 인터페이스 주석의 요구 그대로.
- `saveSummary`: revision CAS + 멱등키 기록을 한 트랜잭션에.
- 배선: 페르소나와 같은 패턴의 빌트인 어댑터로 — `DATABASE_URL`이 있으면
  자동 구성 (OPOD_ADAPTER_MODULE 외부 주입 불필요).
  `OPOD_WORKER_TOKEN`(consolidation 엔드포인트 인증) 설정 필요.

**작업 순서 (완료)**: ① service-backend 마이그레이션 → ② agent 어댑터+
테스트(실 Postgres 대상 통합 테스트) → ③ 배선/env → ④ E2E: 대화 → 재시작 →
기억 유지 확인.

**주의**: 유저 대화에서 추출된 기억이 DB에 남으므로 회원 탈퇴
(`user_withdrawals`) 시 해당 유저의 `agent_*` 행 삭제를 연동할 것.

### Phase 4 — Consolidation 실행 주체: **구현 완료 (2026-07-21)**

설계상 opod-worker가 큐를 소비해 agent의 consolidation 엔드포인트를 호출하는
구조(ADR-0004)나, 별도 워커 서비스가 없다. admin에서 확정한 원칙("워커는
당분간 프로세스 내 실행")을 준용해 **agent 프로세스 내 잡 루프**
(`ConsolidationWorker`)로 구현했다. postgres 드라이버에서만 뜨며
(`MEMORY_WORKER_ENABLED`), FOR UPDATE SKIP LOCKED 클레임 + lease 회수 +
재시도 백오프(`MEMORY_WORKER_RETRY_DELAY_MS`) + 최대 시도 후 영구 실패.
부하가 생기면 별도 서비스로 분리한다.

### 리뷰 반영 (2026-07-21)

- **saveSummary 첫 리비전 CAS 원자화** — 행이 없을 때 `FOR UPDATE`가 잠글
  대상이 없어 동시 생성 둘 다 "saved"가 되던 결함 수정. 검사-후-쓰기를
  조건부 원자 쓰기(첫 쓰기 `ON CONFLICT DO NOTHING` / 이후 `UPDATE … WHERE
  revision = expected`)로 교체, rowCount 0 = conflict. 동시 쓰기 레이스
  테스트 추가.
- **관계 단위 실행 직렬화** — 워커가 잡 클레임 후 관계 해시의
  `pg_try_advisory_lock`(전용 커넥션, 실행 내내 유지)을 잡는다. 실패 시
  attempt 소모 없이 백오프 재큐. 같은 유저×캐릭터의 consolidation이
  인스턴스 간에도 동시에 돌지 않으므로 upsertMany 중복제거 레이스가 큐
  경로에서 사라지고, lease 만료 회수가 살아 있는 원본과 겹치는 중복 LLM
  비용도 막힌다. `chat_memory_consolidation_jobs`에 user_id/character_id 승격
  (마이그레이션 `agent_memory_job_relationship`) — 탈퇴 시 유저 잡 삭제
  타게팅도 이걸로 가능해짐. 직렬화는 큐 경로에만 적용되므로 HTTP
  `/memory/consolidate` 직접 호출 경로는 CAS 프리미티브가 방어한다.

- **잡 payload PII 스크럽** — completed 처리 시점에 `payload_json`(대화
  원문)을 `{}`로 즉시 비운다. 완료된 payload는 어떤 코드도 다시 읽지 않음을
  전 리포 검색으로 확인(소비 유일 지점 = 워커 클레임). 행 자체는 남으므로
  멱등키 중복 방지·이력·탈퇴 타게팅은 유지된다. **failed는 비우지 않는다**
  — 시스템 장애 후 재처리할 수 있는 유일한 단위이므로. 탈퇴 시 agent_*
  일괄 삭제 연동은 아직 미구현(별도 작업).

## 운영 주의

- opod-agent와 opod-admin(콘텐츠 파이프라인)이 같은 페르소나/메모리 스키마
  좌표(`opod.characters`/`character_personas`/`character_canon_memories`)를 읽는다.
  스키마 변경은 opod-service-backend(오너) 기준으로 두 소비자를 함께 조율할 것
  (ADR-0002의 트레이드오프).
- 2026-09-07 최초 인계에서 로컬 복제본은 0행이었으나, 같은 날 개발 DB 읽기 전용 접속으로
  전체 캐릭터 4행·Persona 45행·character memory 79행을 확인했다. 활성 조건과 source hash는
  후속 snapshot 준비 시 확인한다. 실제 매핑 E2E는 격리 입력에서 수행한다.
