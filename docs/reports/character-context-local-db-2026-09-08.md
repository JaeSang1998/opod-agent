# D29 — 페르소나·메모리 구조 변경과 실제 로컬 DB 검증

2026-09-08. **저장·연결 검증 완료, 병합 전 사람 검토 필요.**

## 결론

이제 외부 JSON 파일이 분리 구조를 대신하는 것이 아니라, 실제 PostgreSQL에 페르소나 조각과 캐릭터 메모리 정책을 저장한다. 관리 API → DB → 에이전트 reader → 대화 입력의 연결을 확인했다. 개발 DB와 기존 5433 로컬 DB는 변경하지 않았다.

이번 결과는 **대화가 자연스러워졌다는 판정이 아니다.** 실제 모델 답변과 사용자 판정은 새로 만들지 않았다.

## 무엇을 바꿨나

| 구분 | 이전 D28 | 이번 D29 |
| --- | --- | --- |
| 페르소나 | 외부 manifest가 원문을 읽을 때 분할 | 원문을 유지하고 `character_persona_fragments`에 조각을 별도 행으로 저장 |
| 조각별 용도 | 파일에 kind/injection/recallKeys | 조각마다 성격·말투·배경 등의 용도, 주입 정책, 회수어를 DB에 저장 |
| 캐릭터 메모리 | 파일에서 사실/사건 및 회수 정책 부착 | `character_memories.kind/injection/recall_keys`에 저장. 명시적 사건의 상시 주입은 DB도 거부 |
| 관리 | 원문 변경 시 manifest 재생성 필요 | 실제 인증된 관리 API에서 저장·재조회. 원문과 조각 수정은 한 트랜잭션 |
| 사용자 학습 기억 | 사용자+캐릭터별 별도 테이블 | 테이블 경계를 유지하고 기존 DB 격리·검색 하한 테스트를 실제 DB에서 실행 |

원문 페르소나의 ID·제목·본문은 유지한다. 조각을 이어 붙이면 원문과 정확히 같아야 한다. 원문 SHA-256이 달라진 오래된 저장 요청은 409다. 조각이 있는 원문을 기존 PATCH로 본문만 바꾸는 것도 409로 막는다. 새 구조 API에서는 원문과 조각을 함께 변경할 수 있다. 제목/순서 및 미분류 원문의 기존 CRUD는 유지한다.

같은 원문에 대한 분류만 수정하는 요청은 마지막 저장이 적용된다. SHA-256 검사는 **원문 버전**의 충돌 방어이며 전체 편집 revision 잠금은 아니다. 분류만 저장할 때는 원문 시간값을 갱신하지 않는다. 캐릭터 메모리의 정책 수정은 기존 `updated_at`을 갱신하며, 이 값은 사건 발생 시각이 아니다.

## 실제로 저장한 데이터

새 로컬 DB: `127.0.0.1:55433/opod_persona_memory_local`

컨테이너: `opod-persona-memory-local-20260908`, 이미지 `pgvector/pgvector:0.8.6-pg16`. 루프백에만 바인딩하고 재시작 후 보존을 확인했다. 테스트가 끝난 뒤에도 유지했다. 기존 `ai_sns_postgres`와 그 데이터는 그대로다.

새 개발 DB 접속/덤프 없이 이전에 보관한 snapshot을 사용했다. 실제 사용자 대화 데이터는 새로 가져오지 않았다.

| 캐릭터 | 보존한 원문 | DB 조각 | 캐릭터 메모리 |
| --- | ---: | ---: | ---: |
| 한소이 | 12 | 20 | 13 |
| 서린 | 9 | 16 | 16 |
| 권도건 | 12 | 17 | 25 |
| 나희 | 12 | 17 | 25 |
| 합계 | 45 | 70 | 79 |

15개 혼합 원문을 40조각으로 나누고, 나머지 30개는 1조각씩 저장했다. 캐릭터 메모리 79개는 상시 11개/관련 시 68개이며 과거 사건 26개는 모두 관련 시 회수다. 분류는 기존 D28 실험 데이터를 옮긴 것이며 새로 성격을 창작하거나 특정 캐릭터 예외를 제품 코드에 넣지 않았다.

## 확인한 동작

- 실제 관리자 로그인과 HTTP 요청으로 구조 저장 45회 + 메모리 정책 저장 79회, 합계 124회 성공.
- 실제 PostgreSQL reader가 외부 runtime manifest 없이 기존 D28의 70조각과 같은 본문·분류를 읽음.
- 4명 × 인사/관련 과거 질문/주제 종료 = 12개 대화 입력을 검사. DB 재시작 후 같은 12개를 재검사.
- 과거 사건은 상시 입력에서 제외, 회수어가 맞는 질문에서 포함, 주제를 바꾸면 회수 해제. 캐릭터별 상시 system 입력 hash는 세 상황에서 동일.
- 원문 누락/손상·잘못된 분류 거부, 다른 캐릭터의 원문/메모리 접근 차단, 삭제된 원문 제외.
- 경쟁하는 두 원문 수정 중 하나만 성공하고 다른 하나는 409. 조각 교체 도중 DB 제약 위반이 발생하면 삭제된 이전 조각까지 복구.
- 관리자 앱 연결을 다시 만들어도 읽기 결과 보존. DB 컨테이너 재시작 후에도 4/45/70/79 보존.
- 정본 migration 재실행은 추가 변경 없음. 빈 DB 적용과 레거시 schema 업그레이드 검사 통과.
- 별도 Testcontainers DB에서 신규 구조 down → up 및 트랜잭션 rollback을 검사. 원문은 남고 rollback하면 정책/조각도 복원.
- 원본 snapshot 및 이전 사용자 제출 3개 파일의 SHA-256 불변. 미검수, draft, 선택, 코멘트와 기존 판정은 수정하지 않음.

## 자동 검증 결과

| 검증 | 결과 |
| --- | ---: |
| backend 단위 테스트 | 149 통과 |
| backend DB/HTTP E2E | 99 통과 |
| admin 단위 테스트 | 445 통과 |
| admin DB/HTTP E2E | 16 통과 |
| agent 제품 테스트 — 실제 DB 포함 | 372 통과, skip 0 |
| agent 평가 도구 테스트 | 93 통과 |
| 합계 | **1,174 통과** |

agent coverage gate 통과(전체 statement/line 91.79%). 세 저장소 build/lint, agent runtime/eval typecheck, backend/admin schema 일치 및 canonical migration 생성 drift 검사 통과. 변경 파일의 포맷 및 diff 검사를 실행했다.

전체 포맷 검사는 기존 무관 파일 때문에 실패한다: backend 3개(message-reply.worker.ts/spec, purchases.service.ts), admin 8개(admin-credit-payment/drafts/generation repository, database/json, llm-log repository, draft-worker/generation-job repository, test/drizzle-mock). 이 파일들은 포맷을 고치기 위해 변경하지 않았다. 최초 sandbox의 로컬 포트 제한으로 실패한 HTTP 테스트는 로컬 포트 허용 후 재실행해 통과했다. 새 테스트 fixture의 bio/CSRF 상태 기대값 및 임시 검증기의 타입 오류도 수정 후 재검증했다. 실패 실행을 성공 횟수에 더하지 않았다.

웹은 이번에 변경하지 않았으며 별도 웹 테스트는 재실행하지 않았다. admin 전체 build에 포함된 UI 빌드는 통과했다.

## 코드와 재현 진입점

- 정본 schema/migration: `opod-service-backend/src/domain/database/schema.ts`, `drizzle/20260908093302_persist_character_context/`.
- 관리자: `CharactersController/CharactersService/CharacterRepository`, DTO `put-persona-structure`와 `put-memory-routing`.
- `GET/PUT /api/admin/v1/characters/:id/personas/:personaId/structure`: 원문 SHA-256 및 조각 읽기/원자 저장. PUT은 `sourceSha256`, `fragments`, 선택적 새 `content`를 받는다.
- `PUT /api/admin/v1/characters/:id/memory/:memoryId/routing`: `kind`, `injection`, `recallKeys`. 기존 메모리 목록에서도 저장한 정책을 확인한다.
- reader: `opod-agent/src/persona/postgres-persona-store.ts`. 분리 시 공통 `projectPersonaSources`를 재사용한다.
- 반복 가능한 합성 회귀: admin `test/character-context.e2e-spec.ts`, backend `test/character-context-migration.e2e-spec.ts`, agent `src/persona/postgres-persona-store.test.ts`.
- 승인/설계/체크리스트: `opod-service-backend/.codex/pave/plans/2026-09-08-persist-character-context-local.md`.

private 증거는 `opod-agent/evals/results/persisted-context-local-2026-09-08/`의 `initial-verification`, `restart-verification`, 각 `captures.json`이다. 사용자 원문이 들어가는 capture는 Git에 넣지 않는다. 로컬 검증기는 `evals/results/verify-persisted-context-2026-09-08.ts`다. 최초 실행은 새 결과 폴더에만 가능하고, `--verify-only`는 DB 쓰기 없이 재조회한다. 결과 파일은 덮어쓰지 않는다. 다른 checkout에는 private fixture/증거가 자동으로 따라가지 않으므로 합성 E2E와 구분한다.

## 호환성과 되돌림

새 reader/admin 코드를 사용하기 전에 migration이 있어야 한다. 이 턴에는 개발 DB migration, 제품 배포, `.env` 변경, commit/push를 하지 않았다. 신규 fragment가 없는 legacy 원문과 kind/injection이 null인 canon은 기존 동작을 유지한다. DB 구조를 사용하는 캐릭터에 기존 private manifest를 중복 적용하지 않는다.

조각이 일부 남은 상태에서 원문/순서와 어긋나면 reader가 오류로 차단한다. 단, 직접 SQL로 모든 조각을 지워 버린 경우는 미분류 legacy 원문과 구별하지 못한다. 정상 관리 API는 빈 분할을 거부하고 교체를 원자적으로 처리하므로 이 상태를 만들지 않는다. 전체 조각 삭제까지 감지하는 별도 상태 표시는 이번 스키마에 없다.

기존 코드로 되돌리면 보존된 원문을 계속 읽을 수 있다. 신규 조각 테이블과 메모리 정책 컬럼을 실제로 제거하면 해당 구조 데이터는 사라지므로 먼저 백업해야 한다. 이번 down/up 시험은 폐기되는 테스트 DB의 트랜잭션 안에서만 실행했고, 새 로컬 DB의 구조 데이터는 지우지 않았다. down을 커밋하는 실제 migration rollback 및 배포 순서는 별도 검토 대상이다.

관리 화면의 시각적 조각 편집기는 아직 없다. API만 제공하며, 구조화된 본문 변경은 새 API를 써야 한다. 최종 반영 전에는 DDL 호환성과 이 편집 계약을 사람이 검토해야 한다.

## 아직 입증하지 않은 것 / 다음 작업

실제 모델 호출 0회, embedding 외부 호출 0회, 사용자 판정 추가 0건. 가짜 모델의 문장은 자연스러움/캐릭터성의 증거가 아니다. 다음 품질 검증은 이 DB를 읽는 실제 답변 비교이며 Persona-only/canon-only/사용자 기억 gate-only/결합 조건을 구분해야 한다. 성격·관계·앞선 대화를 검수자에게 제공하고 사용자 선택만 판정으로 기록한다. 회수어의 의역/대명사 처리, 관련도 하한의 실제 embedding 회수율, 정정·망각, current scene 생성은 여전히 미검증/보류다.

Knowledge Delta: 저장 구조의 정본 소유권, 원문/조각 원자 수정, migration 선행 조건을 양 저장소 codebase guide와 ADR0008에 실제 코드/DB 검증 근거로 반영했다. 저장 구조 통과를 제품 대화 품질 통과로 승격하지 않았다.
