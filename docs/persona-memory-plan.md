# 페르소나·메모리 적용 전략 (2026-07-21 확정)

opod-admin 파이프라인에서 확정된 페르소나(표준 블록 12종)와 캐릭터 메모리(세계관 +
게시 역반영)를 opod-agent 채팅에 적용하는 전략. 코드·스키마 조사 결과와 단계별
결정을 기록한다.

## 현재 상태 (2026-07-21 조사)

| 영역 | 상태 |
| --- | --- |
| 페르소나 블록 주입 | 완료 — `PostgresPersonaStore`가 `characters`+`character_personas`+`character_memories`를 직접 읽어 verbatim 주입 (ADR-0002 Resolution) |
| DM 연동 | 완료 — service-backend `sendMessage` → `OPOD_AGENT_URL` (OpenAI 호환 + `X-Opod-*` 헤더) |
| 캐릭터 메모리 주입 | 동작 — 전 메모리를 canon으로 전량 주입 (운영자 세계관 + `auto:` 역반영 구분 없음) |
| 관계 메모리 (유저별 Archival/Core/Summary) | 로직 완성 (ADR-0004/0005), 저장은 인메모리 stub — 재시작 시 소실 |
| Consolidation 실행 | 정책·엔드포인트 있음, 큐 stub — 실행 주체 미정 (opod-worker 서비스 부재) |

## 기능·동작 정의

- **캐릭터 정체성**: 매 턴 시스템 프롬프트에 이름/bio + 블록 12종(순서대로,
  원문 그대로) + 세계관 메모리(canon, 모순 금지). 대화 예시 블록은 few-shot
  목소리 앵커로 동작한다.
- **최근 근황**: 게시 역반영 메모리(`reason` = `auto:` 접두)가 이미
  `character_memories`로 흘러들어 주입된다 — 별도 기능 불필요. 내용에 게시
  날짜가 포함되어 모델이 시점을 가릴 수 있다.
- **유저별 관계 기억**: 관찰(중요도 채점) → 중요도 누적 → 성찰 → Core
  자기갱신 구조 (Generative Agents + MemGPT, ADR-0005). 저장 지속화가 남은 일.

## 단계별 상태

### Phase 1 — 근황/세계관 주입 분리: **보류**

`auto:` 역반영이 canon과 동일하게 전량 주입되는 현 구조를 유지한다.
문제(프롬프트 무한 성장, 오래된 활동의 canon화)는 볼륨이 커져야 실재한다.

**재개 트리거**: `auto:` 메모리 30개 초과 관측 시. 그때 운영자 세계관(전량
canon) / `auto:` 역반영(최근 N개만 "최근 근황" 섹션) 분리 + LLM 선별을 도입.
메모리 전체 100개 초과 시 pgvector 하이브리드 검토(기존 확정 결정).

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
- 멱등 원장 테이블 `agent_memory_operations` 추가 (core/importance/summary
  쓰기 공용) — 총 6테이블.
- E2E 검증 완료: 대화 → 관찰 2건+요약 저장 → 프로세스 재시작 → 새 세션에서
  회상 성공.

**스키마 (opod-service-backend prisma, 확장 불필요)** — 코드 계약
(`memory/types.ts`, `memory-store.ts`, `job-queue.ts`)을 그대로 매핑한 6테이블
(마이그레이션 `agent_relationship_memory` + `agent_memory_job_relationship`):

| 테이블 | 내용 | 핵심 제약 |
| --- | --- | --- |
| `agent_archival_memories` | 관찰/성찰 스트림: content, kind, importance, embedding `double precision[]`, evidence `TEXT[]`, created_at, last_accessed_at | (user, character, last_accessed_at)·(user, character, kind, created_at) 인덱스; upsert 멱등용 (user, character, operation_key, ordinal) 유니크 |
| `agent_core_memories` | 유저 요약 블록 (항상 주입, 자기갱신) | (user_id, character_id) PK |
| `agent_summaries` | 세션 요약: content, turns_covered, revision | (user, character, session) PK; revision 조건부 원자 쓰기(CAS) |
| `agent_relationship_state` | 성찰 트리거 누적치 importance_since_reflection | (user_id, character_id) PK; consume은 단일 `UPDATE … RETURNING` |
| `agent_memory_operations` | core/importance/summary 멱등 쓰기 원장 | (user, character, operation_key) 유니크 |
| `agent_memory_jobs` | consolidation 잡 큐 (user_id, character_id, payload, status, lease) | idempotency_key 유니크; FOR UPDATE SKIP LOCKED 클레임 (admin generation_jobs 패턴) |

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
- 배선: 페르소나와 같은 패턴의 빌트인 어댑터로 — `DATABASE_URL` 있으면
  `STORE_DRIVER=postgres`에서 자동 구성 (OPOD_ADAPTER_MODULE 외부 주입 불필요).
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
  비용도 막힌다. `agent_memory_jobs`에 user_id/character_id 승격
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
  좌표(`opod.characters`/`character_personas`/`character_memories`)를 읽는다.
  스키마 변경은 opod-service-backend(오너) 기준으로 두 소비자를 함께 조율할 것
  (ADR-0002의 트레이드오프).
- 로컬 DB에는 한소이 페르소나가 "기본 페르소나" 1블록뿐이다. 12블록 실데이터는
  운영 DB에 있으므로 E2E 검증은 운영 데이터 스냅샷 또는 시드로 수행할 것.
