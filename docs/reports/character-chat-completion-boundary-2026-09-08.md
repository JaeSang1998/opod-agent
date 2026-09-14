# 캐릭터 챗 개선 — 완료까지 남은 실행 경계

2026-09-08 · `codex/character-chat-p1-persona-router` · 미배포

## 현재 결론

**후속 사용자 결정:** 정정·망각은 나중으로 미루고 직접 대화 개선을 먼저 진행한다.
아래 DDL 제안은 현재 작업의 선행 조건이 아니다. 최신 공통 지침 수정과 실제 응답 검증의
별도 경계는 [직접 자연스러움 개선 보고서](character-chat-direct-naturalness-2026-09-08.md)를 따른다.
이 문서의 검사 수치는 N1 이전 구현 이력이며 최신 제품 회귀는 358건이다.

**공통 저장 경로의 결함은 수정했지만, 자연스러운 캐릭터 챗이라는 최종 목표는 아직 달성하지 못했다.**
코드 검사 성공, 구조화된 필드 추가, 합성 응답은 사용자의 대화 품질 합격을 대신하지 않는다.
최종 기준은 [연구·실행 계획 10.6절](../character-chat-products-persona-memory-research-2026-09-03.md#106-최종-목표-달성-기준-v1-2026-09-07-수립)을 그대로 유지한다.

이번 작업의 반복 구현 승인 질문은 하지 않았다. 다음 세 가지는 별개의 경계다.

1. 정정·망각에는 **새 영속 데이터 계약**이 필요하다. 기존 DB 반입 승인과 다른 신규 DDL이다.
2. Persona의 효과를 판단할 **동등 조건의 실제 모델 응답과 사용자 판정**이 아직 없다.
3. 최종 합격 뒤에도 **개발 서비스 적용 승인**과 적용 후 검증이 필요하다. 운영 DB는 아직 없다.

## 직접 수정하고 확인한 것

| 변경 | 확인한 효과 | 아직 보장하지 않는 것 |
| --- | --- | --- |
| M1 기억 추출·성찰의 응답 검증 | 잘린 응답, 설명문, 잘못된 항목, 없는 인용을 사실로 저장하지 않음 | 형식이 맞는 문장의 진실성 |
| C1 캐릭터 기억 read model | 기존 79건의 ID·분류·시각 보존, 4명의 prompt 원문 동일 | 자동 관련성 선택·사건 만료 |
| S2 사전 선택 실험 경로 | 고정한 source 선택을 실제 target 경로로 검사, 잘못된 선택은 호출 전 거부 | 자동 선택기 또는 자연스러움 향상 |
| M2 겹치는 요약 작업 | 실제 4메시지를 6개 처리했다고 기록하던 오류 제거 | 정정된 사실의 모든 재유입 차단 |
| M3 빈/초과 요약 응답 | 빈 Summary는 처리 위치를 전진시키지 않음. Core는 문장 중간에서 자르지 않고 실패·재시도 | 의미적 요약 품질·완전한 망각 |
| 검수 웹의 캐릭터 목록 회귀 | 고유 ID/표시 ID 구분, 순서 보존, 잘못된 행 제외, 미설정/서버 장애의 수동 입력 fallback 검증 | 실제 사용자 대화 검수나 UI 동작 변경 |

M3는 먼저 5건의 실패를 확인한 뒤 수정했다. 빈 Summary의 최초/기존 상태, 같은 job의 재시도,
빈/초과 Core의 기존 값 보존과 성찰 예산 복구, 정상 재시도의 중복 저장 방지를 검증했다.
정확히 길이 한도인 Core는 그대로 저장한다. 빈 성찰 결과는 기존처럼 합법이며 공통 응답 함수를
무조건 non-empty로 바꾸지 않았다. Core 전에 저장된 유효한 observation/reflection은 유지된다.
단계 전체를 rollback했다고 표현하지 않으며, 기존 멱등 저장으로 재시도 시 중복을 막는다.

## 최신 검증

| 검사 | 결과 |
| --- | --- |
| 제품 전체, 실제 로컬 DB 포함 | **348/348 통과** |
| 평가 도구 회귀 | **92/92 통과** |
| 웹 회귀 | **42/42 통과** |
| 제품/평가/웹 타입 검사, lint, dead-code | 통과 |
| 제품 빌드, 웹 빌드 | 통과 |
| 제품 coverage | 92.40%, 기준 통과. DB 미연결 332건/16 skip의 측정이며 DB 348건 실행은 별도 |
| 평가 coverage | 기존 집계 범위 85.16%, 기준 통과. target/comparison CLI 전체 coverage 아님 |
| 웹 coverage | **93.55%, 기존 기준 90% 통과**. 초기 88.14% 실패 후 캐릭터 목록 계약 회귀를 추가 |
| 전체 `npm run check` | **통과**, 모든 coverage 기준과 제품/웹 빌드 포함 |
| Persona 구조 검사 | STRUCTURE-PASS, 대화 품질 평가 아님 |
| 기억 lifecycle 구조 검사 | **STRUCTURE-PASS POLICY-FAIL** |

초기 전체 검사는 웹 coverage 88.14%로 실패했다. backend 공개 목록→검수 웹→Agent Persona의
고유 ID 연결과 장애 fallback이 기존 테스트에서 빠져 있음을 확인하고 해당 계약 5건을 추가했다.
웹 제품 소스와 coverage 설정은 변경하지 않았다. 단순 getter/상수 테스트나 기준 완화는 없다.
후속 전체 검사에서는 웹 coverage 93.55%와 웹 빌드까지 통과했다.
기억 정책 실패는 기능 부재이며, 최종 G4/G7을 통과 처리할 수 없다.

실행: `npm run check`, 로컬 `TEST_DATABASE_URL`을 지정한 `npm test`, `npm run build:web`,
`npm run eval:memory-structure`, `npm run eval:persona-router`, `git diff --check`.
로컬 큐가 비어 있음을 확인한 뒤 DB 통합 테스트를 실행했고 테스트 소유 행만 정리했다.
새 구조 결과는 ignored 경로 `evals/results/2026-09-08T00-09-09-239Z/`와
`evals/results/persona-router-2026-09-08T00-09-09-874Z/`에 있다.
추가 유료 모델 호출·개발 DB 쓰기·DDL·배포·commit/push는 실행하지 않았다.

## 보류한 Memory 구현 제안 — 아직 승인·구현되지 않은 설계

이 절은 새 제품 사실이나 확정 schema가 아니라 **DDL 검토용 제안**이다. 기존 Store가 없는
필드를 저장하는 척하거나, fixture 상태만 필터링해서 정정·망각을 완료 처리하지 않는다.
소유자 확인 결과는 `owner-found`: Agent의 `MemoryStore`/Postgres adapter와
`ConsolidationService`, backend의 `schema.ts`/`MessageReplyWorker`/provider다.

### 성공해야 하는 사용 동작

- 인증된 사용자가 자기 캐릭터 관계의 대상 기억을 정확한 ID로 정정·망각한다.
- 정정은 기존 사실과 대체 사실을 연결하고, 새 사실을 유사도 dedup 때문에 버리지 않는다.
- 망각 완료는 이후 모델 입력과 완료 이후 저장·전달되는 답변에서 대상 정보를 재사용하지
  않는다는 뜻이다. 기존 화면의 대화 삭제나 백업의 물리 삭제를 뜻하지 않는다.
- 대상이 아닌 사용자 사실, 다른 사용자/캐릭터의 데이터와 캐릭터 canon은 보존한다.
- 대상이 모호하거나 출처를 검증할 수 없는 legacy 기억은 성공이라고 응답하지 않는다.
  별도의 정확한 출처 지정/이관이 필요하며 무관한 사실까지 모두 지우는 fallback은 쓰지 않는다.
- 자연어에서 정정·망각 의도를 자동 판단하는 기능과 정확한 대상 ID의 저장 API는 구분한다.
  확실하지 않은 모델 추측에 삭제 권한을 주지 않는다.

### 제안하는 migration 작업과 데이터 영향

정본 수정 대상은 backend `src/domain/database/schema.ts`, 그 변경만 생성한
`drizzle/*_agent_memory_lifecycle/migration.sql`/`snapshot.json`,
`opod-admin/src/domain/database/schema.ts`의 기존 schema 미러다.
생성 시각에 정해지는 migration 폴더명 외에 별도 임의 schema 파일을 만들지 않는다.

| 대상 | 제안 작업 | 목적 |
| --- | --- | --- |
| `agent_archival_memories` | `status` text, 기본 `active`, `active/superseded/forgotten/stale` check; `source_refs` jsonb, 기본 빈 배열; nullable `supersedes_id` uuid 자기 참조 | 상태·실제 발화 근거·정정 전후 연결. 기존 원문/embedding/evidence는 유지 |
| `agent_relationship_state` | `memory_revision` integer, 기본 0, 음수 금지 | 정정/망각 이전 입력을 읽은 쓰기를 차단하는 관계별 세대 |
| `agent_core_memories`, `agent_summaries` | 각각 `memory_revision` integer, 기본 0, 음수 금지 | 변경 전 파생 기억의 사용 차단. Summary의 기존 CAS revision과 역할이 다름 |
| `message_reply_jobs` | nullable `context_memory_revision` integer, `context_memory_ids` uuid 배열과 `context_message_ids` uuid 배열, 기본 빈 배열 | 생성 중 답변의 세대 확인 및 후속 history의 파생 답변 출처 추적 |
| 신규 `agent_memory_mutations` | UUIDv7 ID, user/character text, operation key text, correction/forget 종류, target memory UUID 배열, source refs jsonb, nullable replacement memory UUID, memory revision integer, 생성 시각. 관계+operation key unique | 정정/망각 멱등 기록과 후속 history에 적용할 출처 제한의 영속 정본 |

`source_refs`는 실제 message ID와 원문 hash, 인용 구간(start/end)의 구조화된 배열을 뜻한다.
같은 메시지의 다른 사실까지 지우지 않도록 **메시지 전체 제외와 구간 제외를 구분**한다.
인덱스 단위는 현재 TypeScript 문자열의 UTF-16 code unit으로 명시하며 hash/범위/인용 일치,
메시지 소유 관계를 검증한다. 모델이 적어 준 숫자만 믿거나 대화 위치를 message ID로 만들지 않는다.
새로 추출하는 observation의 출처는 사용자 발화로 제한한다. Reflection의 기존 evidence는
유효한 기억 ID를 연결하고 파생 의존성을 따라 무효화한다.
`stale`은 명시적으로 사용 불가로 확인한 상태이며 등록 시각이 오래됐다는 이유로 자동 지정하지
않는다. 캐릭터 Current State의 정본 공급자/만료 정책은 이 사용자 기억 migration과 별개다.

위 변경은 원문 삭제나 데이터 backfill을 자동 실행하지 않는 additive migration이다.
기존 출처 없는 행을 완전한 lifecycle 지원 행으로 자동 승격하지 않는다. 정확한 FK/index/check와
생성 diff는 구현 시 검토하되 표에 없는 테이블·원문 변경은 계약 확대이므로 다시 범위를 드러낸다.
backend의 미커밋 qwen embedding 및 DM 순서 변경을 보존한다. 생성기가 관련 없는 pending schema
변경을 같은 migration에 섞으면 적용하지 않는다.

### 같이 구현해야 할 경로

1. backend가 원본 message ID와 검증된 source 정보를 Agent에 전달한다. provider 경계에서
   내부 출처 metadata가 모델의 사용자 문장이나 공개 답변에 섞이지 않게 한다.
2. Agent의 추출·저장·reflection·Core·Summary·검색이 같은 lifecycle 계약을 따른다.
   최근 관찰, top-K 검색, dedup, reflection evidence 중 어느 한 우회에도 폐기 상태가 들어가면 안 된다.
3. 관계 단위 동일한 잠금/트랜잭션 순서에서 대상 상태 변경, 새 revision, mutation 기록과
   파생 기억 무효화를 함께 반영한다. 새 Core/Summary는 유효한 근거에서 재생성한다.
4. 모든 비동기 job은 읽은 revision을 보존하고 **실제 쓰기 직전** 다시 확인한다. HTTP 수동
   consolidation도 같은 검사를 적용한다. stale 작업은 재저장·예산 복원으로 옛 상태를 되살리지 않는다.
   무효화된 작업의 원문 payload도 완료 경계에 맞게 비운다.
5. backend는 후속 history의 대상 구간과 의존 답변을 제외/가림 처리한다. 메시지 좌표는 유지한다.
   답변 생성 중 mutation이 발생하면 완료 트랜잭션에서 revision 불일치를 잡고 옛 답변을 저장하거나
   과금하지 않는다. 새 문맥 재시도는 기존 제한/크레딧 예약 계약을 유지한다.
6. 기존 익명/수동 입력과 출처 없는 과거 작업은 revision 0의 legacy 호환에만 한정한다.
   lifecycle 변경 이후 이를 현재 자료로 조용히 승인하지 않는다. 과거 source hash가 다르거나
   이관되지 않은 관계는 미지원으로 노출하고 최종 G4 검증에서 빼서 통과시키지 않는다.

### 검증·적용·되돌리기

- 실제 로컬 DB/일회용 테스트 DB에서 저장→재시작→조회→정정→망각, 동일 요청 재시도와 중간
  실패를 검증한다. 다른 관계, 같은 발화의 무관한 사실, 정정 이후 사용자가 새로 제공한 사실을
  positive control로 함께 검사한다.
- 정정/망각 전에 시작한 extraction/reflection/summary/답변 완료를 각각 지연시켰다가 해제한다.
  완료 후 Archival/Core/Summary/history/새 모델 payload 어디에도 대상이 재유입되면 실패다.
- schema 생성/기존 DB upgrade/fresh migration/admin 미러와 backend 회귀를 검사한다.
  Agent runtime/eval/web 검사도 실행한다. 이번에 통과한 웹 coverage 기준도 그대로 유지한다.
- 제안된 추가 권한은 **코드·migration 작성과 로컬/테스트 DB 검증까지**다. 개발 DB 적용,
  배포, 실제 사용자 대화 반입, 신규 유료 모델 호출은 포함하지 않는다.
- 실제 적용 전 단계에서는 additive 필드를 남겨 두고 코드만 되돌릴 수 있다. **망각을 수행한 뒤
  구형 코드로 그대로 복귀하면 폐기 기억을 다시 사용할 위험이 있으므로 안전한 rollback이 아니다.**
  그 경우 lifecycle 검사를 유지하는 호환 버전으로 복귀하거나 해당 관계의 memory 기능을 중단한다.
  mutation 기록/제외 정보를 버리거나 옛 snapshot을 복원해 망각을 취소하지 않는다.

이 제안은 새 DDL과 기억 변경 동작을 함께 검토해야 하므로 현재 자동 진행 경계 밖이다.
PAVE의 별도 DDL 승인 규칙에 따라 migration은 아직 작성·생성·적용하지 않았다.

## Persona 및 최종 검증의 별도 경계

기존 12회 모델 실행은 이력이지만 원문 artifact가 현재 checkout과 확인한 원격 경로에 없다.
읽기 전용으로 새 4명/45/79 snapshot을 복구했으나 그것을 과거 12응답으로 대체하지 않았다.
해당 원문을 복구하거나 새로 승인된 소규모 비교를 실행해야 한다. 새 실행은 제공사/reasoning을
고정하고 실제 응답 metadata로 확인하며 원문과 모든 실패를 보존한다.

그 후 사용자에게 조건을 가린 최대 8쌍 묶음을 제공하고 사용자 판정만 집계한다.
사전 선택의 이득이 확인되면 실제 자동 selector의 지시어/주제 종료/필수 회상 일반화를 확인한다.
최종 최소 864응답과 추가 기억 호출을 지금 일괄 실행할 권한으로 해석하지 않는다.
새 비용 계약은 실제 모델·제공사·출력 상한·추가 호출 상한이 정해졌을 때 산정해야 한다.

## 병합 전 검토와 지식 반영

공통 데이터 계약 변경은 **검증됨; 병합 전 사람의 코드 검토 필요** 상태다.
핵심은 구형 job 호환 범위, Core 초과/빈 응답의 실패·재시도, lifecycle 제안의 완료/rollback 경계다.
확인된 M3 저장 규칙은 [적용 전략](../persona-memory-plan.md)에 `repo-evidenced`로 반영한다.
이 문서의 새 lifecycle 설계는 `recommended-unconfirmed`이며 확정된 제품 규칙으로 승격하지 않는다.
별도 코드베이스 가이드가 없는 Agent 저장소에 새 가이드나 PAVE 런타임을 만들지 않았다.
