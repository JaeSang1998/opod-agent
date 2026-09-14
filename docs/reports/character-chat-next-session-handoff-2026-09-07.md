# 캐릭터 챗 자연스러움 개선 — 다음 세션 인계

- 인계일: 2026-09-11 갱신(파일명은 기존 링크 보존)
- 작업 브랜치: `codex/character-chat-p1-persona-router`
- 범위: 캐릭터 공통 Persona·Memory·평가 구조
- **최신 방향 / 통합 구조 개선(9월11일):** 사용자는 문구 튜닝보다 페르소나·메모리·검색·주입
  구조와 내용을 함께 개선한 뒤 세부 조정하길 원한다. 논문 기반 초안 후 “ㅇㅋ 진행해”로 상세화.
  D36 실행은 현재 진행 순서에서 보류. 9월10일 D36 32답변/$1/무재시도 승인은 대화에 있었으나
  새 통합 실험/embedding에 재사용하지 않는다. 아래 과거 준비기록의 승인=false는 당시 snapshot이다.
  9월11일 전용 로컬DB55433 read-only 확인: PG16.15/vector0.8.6, 원문45/조각78/canon79/
  archival0. canon vector(1024)컬럼은 이미 있지만 벡터/모델라벨 채워진 행0이다.
  상세 계약은 [통합 로컬 구현 계획](../../../opod-service-backend/.codex/pave/plans/2026-09-11-character-chat-integrated-context-local.md).
  I1~I5는 기존 테이블 추가컬럼, 공통 혼합검색, 원문/출처 연결, 입력예산, 합성DB검증이다.
  **“DDL 포함 진행” 승인 수신, I1~I5 로컬 구현·합성 검증 완료.**
  canonical `20260911063302_character_chat_context`를 백업/복원 시험 후55433에 적용했다.
  검색·근거 기억·요청 바이트 예산을 공통 경로에 연결. 과하게 묶인 배경4개만 API로 분리해
  원문45/canon79는 byte 동일, 조각78→86. 성격/말투 자체를 또 튜닝한 작업이 아니다.
  실제 DB 제품431/평가96/backend migration4/admin API7 테스트 통과, typecheck/build/lint/schema확인.
  현재 전용DB archival0,실제벡터0. 기존 검수/비교/첨부489파일 hash불변, 사용자판정추가0.
  `CHARACTER_CONTEXT_MODE=integrated`가 새 경로, 기본legacy 유지. 제품 연결의 embedding모델을
  추정하지 않아 새 기본 연결은 lexical만 사용한다. 의미 검색은 합성1024벡터로 경계만 검증했다.
  실제 모델/금액 제한 검증 전에 색인 CLI를 실행하지 말 것. 자연스러움 개선 완료 주장 금지.
  최종 private 증거 `evals/results/context-local-2026-09-11-rgY7E1/`의 final-db-verification,
  final-captures,테스트로그,백업 및4개 원문 API rollback 입력 참조. merge전 사람 리뷰 필요.
  개발DB·외부모델·웹게시·commit/push0. 다음은 별도 비용·전송 계약으로 실제 품질 비교다.
  원문 보존/캐릭터별 코드분기 금지/사용자 검수만 판정/정정·망각 보류는 유지한다.
  실제 embedding/답변/추출/요약/성찰 실행은 모델·자료·총비용 계약을 따로 확정해야 한다.
- **최신 D36 / 공통 지침·말투 분리 후보 준비(9월9일):** 사용자 “다음 진행해”의 로컬 입력 분석/
  수정 후보 준비 범위만 수행했다. 제품 코드·로컬/개발 DB·검수 화면 미변경, 실제 답변/새 판정0.
  D31 보관 스냅샷을 StubPersonaStore로 기존 HTTP 경로에 넣어 D35 최신16입력을 정확히 재현했다.
  말투4문단만 고친16입력도 HTTP 캡처. 공통 지침은 캡처된 system의 해당 구간만 오프라인 교체.
  control/policy-only/voice-only/combined 총64입력. 시스템 외 모든 메시지·기억·시각·관계·sampling고정.
  본문 크기3,215→2,041bytes는 입력 관찰이지 품질/토큰/비용 우세 아님. 성격/기억 원문 유지.
  말투 후보는 별도 실험 block ID와 원래 source ID/hash 대응을 보관, 이름/ID별 제품 분기 없음.
  보호518파일 불변, 변경 오염 거부6개, 64조건 대조/일차32순서 균형 검증, 제품123+검수5 통과.
  일차 제안은 알람·근황×4명×4조건=32답변/$1/무재시도. **외부 실행 승인=false**.
  인사·라면 보조32입력은 이 범위에 포함되지 않는다. 기존 D35 소진 승인을 재사용하지 말 것.
  실행 전 제공자/가격/파라미터 재확인. 추가 모델·개발 설정 접근·DB 변경/DDL·웹 게시·commit/push0.
  정본 private `evals/results/direct-reply-d36-offline-2026-09-09/`: candidate-content,voice-diff,
  persona-candidate-snapshot,current-http-captures,comparison-inputs,input-audit,manifest,
  verification,final-verification,protected-hashes,artifact-hashes. 기존 파일 덮어쓰기 금지.
  과거 메시지 누락과 추가 기억 주입만으로 이번 실패를 설명할 수 없다는 입력 근거는 확인했다.
  공통 지침/말투/모델/문맥 배치의 인과는 미확정. 새 문맥·반복·장기 대화 검증은 후속 단계다.
  [후보 변경·4조건·검증·실행 경계](character-chat-reply-input-isolation-2026-09-09.md).
- **D35 / 사용자 검수 접수(9월9일):** `packet-81ff739ab748`, `packet-ea8066769244`의
  16쌍 선택을 원문·비공개 대응표에 대조했다. A2/B6/tie1/both_bad6/abstain1이며,
  실제 조건은 **이전안5 / 최신안3 / 둘 다 나쁨6 / 동률1 / 판단 보류1**이다.
  이전안은 N1-after 입력, 최신안은 현재 D31 입력으로 D35에서 새로 생성한 답변이다.
  최신 선호3은 소이 인사·도건 인사·서린 라면. 알람은4캐릭터 모두 both_bad, 라면은이전3/최신1.
  자연스러움 개선 완료·최신안 전면 채택 근거가 아니다. 개별32답변 모두 not-reviewed,
  PASS0/FAIL0, 사용자1명·두draft 유지. 선택8개만 방향 선호이며 tie/both_bad/abstain을 승자로 바꾸지 않는다.
  나희 알람의 ‘그나마 B’는 both_bad 유지. 소이/도건 근황의 짧은 수정 제안은 원문 합격·
  현재 활동 사실의 승인 아님. 서린 초면 인사 의견은 조건부이며, 나희 근황 tie/‘둘다 나쁘지 않음’도
  개별 PASS가 아니다. 문맥 연결·불필요한 뒷말·문장 구사·성격별 반응이 후속 검토 대상이다.
  새 수정이나 추가 모델 실행은 하지 않았다. 이름/ID별 예외·정답 문구·전역 말투 금지로 바꾸지 말 것.
  접수 정본 private `evals/results/direct-context-d35-user-review-2026-09-09/`의 원첨부·
  정확한JSON·receipt·보호hash. JSON SHA256 `0178a2c7a4a6e1c5df492bc07ebd1feb533d18ea827d00b3a0e85cfac5fcd268`.
  기존 스키마·32원문/문맥·16쌍 대응·draft 집계 거부 확인, 검수 회귀5/5, 중복 제거509파일 불변.
  이전 실행의 template/humanReviewed:false는 생성 당시 기록으로 보존했다. 최신 검수는 별도receipt를 볼 것.
  N1/D32에 적용된 이번 판정0·새 모델 표본0. 모델 호출/DB 접근·쓰기/제품·UI 변경/웹 게시/commit-push0.
  전체 제품 검사는 미재실행. D35 기존32회 승인 소진 상태 유지. [검수 결론·코멘트 경계](character-chat-same-context-comparison-2026-09-09.md).
- **D35 / 같은 문맥 실제 답변 및 원격 게시 완료 이력(9월9일):** 새 32답변/$1/무재시도
  승인 질문에 사용자가 “진행해”로 응답했다. 32시도/32답변/16쌍, API비용$0.0259086744,
  Xiaomi/mimo-v2.5-pro·stop32, 재시도/추가LLM/실제embedding0. **이번 승인도 소진됐다.**
  실행 private `direct-context-d35-approved-2026-09-09/`의 completed/results가 정본.
  준비 입력 불변, 최종 검증 보호대상523파일/전용로컬DB 불변. 제품105+평가26 회귀 통과.
  최신안의 “바로 뿌리세용”, 근거 없는 촬영 종료, 알람에서 세 캐릭터의 “무서운 거” 수렴이
  남아 채택 보류. 분석자 관찰이며 사용자 FAIL·개별 PASS·승자 판정 아님. 실행 완료 당시 새 검수0; 이후 접수는 위 항목.
  셀렉 출력은 구/신 모두0; 오왔어요 구1/신0 한 표본을 개선 일반화에 쓰지 않는다.
  bond표시 누락 구8/신8은 별도 부가 신호 관찰. 이번엔 관계/메모리 저장을 수정하지 않았다.
  신규packet `packet-81ff739ab748`, `packet-ea8066769244`, 개별/쌍별 전부draft/not-reviewed.
  [새 32답변 검수 화면](https://opod-chat-review-sep08.mute1478.chatgpt.site/d35.html)을 기존
  소유자전용 Sites version5로 게시, succeeded 확인. 기존 판정/ID/저장키 보존, 과거 N1 표시 추가.
  원격 화면6개 모드·build·archive검증 통과, 브라우저/모바일/native WebMCP QA 미실행.
  Site source commit `0a4bc9cbec80fed35684df8a3b2b5cf266405761`; 자료는별도 `fc33e5b`.
  개발 설정 URL·모델·키3개만 read-only로 읽었고 LLM은Mac직접호출. 개발DB쓰기/제품변경/
  DDL/제품배포/제품commit-push0. `run-direct-context-d35-approved-2026-09-09.mjs run` 재실행금지.
  [결론·미해결 원문·비용·검증·실행 경계](character-chat-same-context-comparison-2026-09-09.md).
- **D35 / 같은 지적 문맥 비교 준비 이력(9월9일):** N1-after 정확한 입력16개와 현재 D31
  최종 로컬 DB/현재 런타임 입력16개를 동결했다. 4명×인사/근황/라면/알람, 당시 대화·
  고정 이전 응답·15시KST·문맥별XP0/120/320/600·마지막접촉 하루 전·샘플링을 보존했다.
  원래 casesHash와 N1 요청 hash, 구/신 실제 clock/bond 안내의 동일성 확인.
  최신 HTTP 캡처16건, 잘못된 비교조건 거부5건, 관련 제품105+검수5회귀 통과.
  D31 DB read-only/불변, 보호대상515파일 hash 불변. 입력의 셀렉4→0/오왔네요4→0,
  추가 배경/사건 기억 선택0/16은 입력 관찰일 뿐 실제 답변 자연스러움 입증이 아니다.
  **모델 답변0/새 판정0/유료 실행 승인=false.** D32 소진 승인을 재사용하지 않는다.
  준비 정본 private `evals/results/direct-context-d35-offline-2026-09-09/`.
  `prepare-direct-context-d35-2026-09-09.mjs verify`는 읽기 전용 검증이며 prepare 재실행 금지.
  추가 최대32답변/$1/무재시도 범위 승인 후 현재 제공자 조건 재확인 필요. 예약합$0.571806.
  제품 코드/DB쓰기/DDL/개발서버 접근/웹 게시/commit/push 없음. 전체 check는 미재실행.
  [비교 정의·전체 문맥·검증·실행 경계](character-chat-same-context-comparison-2026-09-09.md).
- **최신 D34 / N1 재검수 접수(9월9일):** 첨부된 원문은 최신 D32가 아니라 9월8일 N1의
  `packet-3132ff38c03c`, `packet-f894b0192ba9`다. 같은 사용자의 재검수이며 새 표본/검수자 아님.
  A2/B5/tie2/both_bad6/not-reviewed1(메모만), 개별32답변 모두 not-reviewed·두 submission draft 유지.
  pairwise 선택15건, 이전 N1 제출과 선택값8건이 달라 새 snapshot으로 별도 보존했다.
  최신 N1 견해에는 이번 snapshot을 쓰되 이전 제출은 이력으로 보존하고 중복 가산하지 않는다.
  ‘굳이 A’가 적혀도 구조화 선택 both_bad 유지; 부정적 인사 메모도 not-reviewed 유지;
  B 선호와 ‘오랜만’ 문맥 판단 불가, 문장 일부만 자연스러움도 개별 PASS로 바꾸지 않는다.
  접수 정본: private `evals/results/direct-naturalness-n1-rereview-2026-09-09/`의 원첨부·
  `user-review-submissions.json`·`user-review-receipt.json`·`protected-hashes.json`.
  JSON SHA256 `d1d31ed425d38677eb95a43e7151ecbdb1f9e5d857306da7b3f997ffe4f3d8ee`.
  기존 스키마·packet/원문 대응·draft 집계 거부 확인, 검수 회귀5/5, 기존259파일 hash 불변.
  N1 당시 입력에서 도건 인사/나희 셀렉 예시를 재확인했다. 모델 내부 원인·모델 단독 결함은 미확정.
  사이트 `/`는 여전히 N1, `/d32.html`이 최신이다. 오래된 원문의 재검수를 최신 후보 재발로
  잘못 집계하지 않는다. 최신 D32 검수는 여전히0이며, 해당32답변에 문제 문구가 없다는 사실도
  다른 문맥의 재발 방지/자연스러움 입증으로 쓰지 않는다. 안내 구분 부족을 사용자에게 설명했다.
  이번에는 제출/인계/보고서만 갱신. 모델 호출·DB 접근/수정·제품/UI 코드·웹 게시·commit/push0.
  [접수와 해석 경계](character-chat-direct-naturalness-2026-09-08.md#d34--n1-재검수-접수2026-09-09).
- **D33 / D32 원격 검수 게시 이력:** 사용자가 기존16쌍을 4쌍씩 원격 검수 화면으로
  정리하는 다음 작업에 “진행해”로 승인했다. 추가 생성/페르소나 수정이 아니라 검수 전달 작업이다.
  [9월9일 검수 화면](https://opod-chat-review-sep08.mute1478.chatgpt.site/d32.html)에32원문/16쌍을
  기존 owner-only Sites의 version4로 게시, 배포상태 `succeeded` 확인. 공개 범위 변경 없음.
  4쌍 묶음은 화면 이동만 나눈다. D32의 두packet ID·item/pair ID·순서·A/B 대응은 그대로다.
  기존 공통 성격·말투 원문의 짧은 발췌와 전체 펼치기, 합성 관계 전제·직전 대화를 제공한다.
  참고 설정은 두 조건 공통이며 실제 주입문과 다르다고 표시했다. 조건 매핑·raw reasoning·
  실제 사용자 대화·인증키는 게시하지 않았다. 사전에 원문 보고서를 본 사용자의 완전한 눈가림을
  보장하는 것은 아니며, 웹 화면은 A/B 조건명을 공개하지 않는다는 뜻이다.
  판정은 브라우저 로컬 draft이고 자동 제출되지 않는다. `판정 복사` 후 원래 대화로 보내야 한다.
  선택 취소/미검수와 선택 없는 메모를 저장·재로드·내보내기해도 개별 PASS로 바꾸지 않는다.
  **새 사용자 검수0, 자연스러움·캐릭터성 합격 판정0.** 제출이 오면 해당 선택/코멘트만 반영할 것.
  사이트 소유자 `reviewSourceForPackets`와 기존 디자인/내보내기를 확장했다. 별도
  `opod-chat-review-site` 저장소만 자료/기능2커밋 후 Sites에 push했다
  (`1da75e1`, `28360cfba2c70eb627dad7646cfc1b819a421bb1`). 제품 저장소 commit/push는 없다.
  n1/n2/n3/briefs/d32 5개 UI 로직 검사와 build 통과. 원문·공통 문맥·4쌍 이동·복사 실패 대안·
  미검수 메모 복구 검사 포함. D31/D32 자료·과거 제출·이전 화면 소스140파일 hash 불변,
  과거3화면 생성 소스 byte-identical, 게시 archive의4화면과 검증한 build 일치.
  실제 브라우저/모바일 레이아웃·native WebMCP QA는 수행하지 않았다. 디자인 검사기는 HTML
  파서 부재로 regex fallback만 수행했으므로 대비/레이아웃 통과 근거로 쓰지 않는다.
  private `evals/results/context-review-site-2026-09-09/`에 hash/검증/배포 기록과 archive 보관.
  모델 호출/개발 서버 접근/DB 쓰기/DDL/제품 코드 변경0. 사이트 README에 검수 보존 규칙과
  기존 소유자·검증 한계를 기록했다. 품질 가설이나 추가 아키텍처 규칙은 승격하지 않았다.
- **D32 / D30-D31 실제 답변 비교 실행 이력:** 사용자 “ㅇㅋ 그럼 테스트 진행해”로
  같은4명·로컬출발 OpenRouter/Xiaomi·최대32답변/$1/무재시도 범위를 승인했다.
  동결한 D31 준비 입력을 사용해32시도/32답변/16쌍 완료, API usage.cost 합계**$0.0190274052**.
  제공자 Xiaomi, 모델mimo-v2.5-pro, stop32건, 클라이언트 재시도/추가LLM/embedding/judge0.
  이 승인은 소진됐다. `run-context-d31-approved-2026-09-09.mjs run` 재실행/재개 금지.
  private `evals/results/context-optimized-approved-2026-09-09/`의 `completed.json`,
  `results.json`, 각attempt/raw/result, provider snapshot, 검수 packet이 실행 정본이다.
  manifest는 시작 기록이며 종료는completed를 본다. 입력D31 폴더와 과거 사용자 제출은 불변이다.
  신규packet `packet-d8f646723268`, `packet-953405aa4d6b` 각8쌍/16답변,
  개별/쌍별전부draft/not-reviewed. template를 사용자 제출로 세지 않는다. D32 당시에는 새 웹 게시 없음.
  실제 원문 전체와 문맥은 [D32 보고서](character-context-model-comparison-2026-09-09.md).
  나희 후속은 주입한 촬영 전 취향과 대응하지만, 서린 초면 반말/문장 연결과 자료 없는 부연 등
  검토점이 남는다. 이는 관찰이지 사용자 FAIL·승자 선택 아님. 자연스러움·캐릭터성 개선 확정/병합 금지.
  16개씩 비교, 조합당 1표본. 장기 자율 대화/친밀도/사용자 학습 메모리 품질 검사로 확대하지 않는다.
  prompt tokens 43,103→33,319이나 비용은 후보가 더 큼(캐시량/출력량 차이); 품질·성능 우세 확정X.
  기존 bounded provider/review 26개와 전체 check 521개(제품386 DB skip0/평가93/웹42) 재통과.
  최종 verify는 실제 본문·비용·쌍 대응·기존 hash·최종 로컬 DB 불변 확인. 제품 코드·캐릭터 DB 수정 없음.
  로컬 환경/DB에 API키가 없어 사전 설명 후 기존 개발 설정 URL/키/모델 3항목만 read-only로 읽었다.
  키는 프로세스 메모리/인증 헤더에만 사용; 개발 DB 쓰기·대화 중계 없음. LLM 요청은 Mac 직접 전송.
  D31의 “개발 서버 접속0/실제 답변0/승인 대기”는 이전 턴 이력이다. DDL/배포/게시/commit/push 없음.
- **D31 / 내용·선별 주입 로컬 후보 이력:** 공식 문서·원논문7개를 대조하고 공통 recall 소유자에
  구체 키 우선/각 lore·canon4개·1,200code point/목록 내 동일 본문 제거/짧은 지시적 후속/
  명시 주제 종료 규칙을 적용했다. system은 명시 nonempty identity가 있으면 중복 bio 제외.
  캐릭터 이름/ID 예외 없음. 사용자 학습 기억·공통 답변 지침·모델 sampling은 변경하지 않았다.
  전용 로컬 DB source23행, canon본문20행·회수정책24행을 관리 API69회로 편집했다.
  현재45source/78조각(상시31/조건부30/제외17), canon79(상시0). D30 말투·제외 자료는 보존.
  D30/내용만/선별만/결합128캡처 + 최종내용32재검사/추가4 =164입력.
  선별만은 동결 Persona Store replay, 다른 조건/최종은 실제 DB reader. 최종 핵심32요청은
  combined와 byte-identical. 후속 커피 정보4/4, 주제 종료 뒤 추가 커피 주입0/4.
  **입력 구조 검사이지 실제 답변·자연스러움 PASS가 아니다.** 실제 LLM/embedding/새 사용자 판정0.
  `TEST_DATABASE_URL=<전용 로컬 DB> npm run check`: 제품386(DB skip0)+평가93+웹42=521통과,
  lint/dead-code/typecheck/build 포함. admin/backend 전체 검사는 이번에 재실행하지 않았다.
  `evals/results/context-optimized-2026-09-09/`의 `content-final-db.json`, `candidate-final.json`,
  `audit.json`이 최종 정본. 원래128캡처/초기candidate는 이력으로 보존한다. private 생성기3개는
  D31 보고서 참조. 기존 출력 경로 재실행·D30 초기화·전체 DB 덮어쓰기 금지.
  D30 복구는 `rollback-final-inputs`의 해당23source·변경canon만 최종값과 대조 후 로컬 API 사용.
  복구 입력만 보관, 실제 복구 미실행. source와 이전 사용자 제출3개 hash는 보존됐다.
  새32요청/16쌍(D30 대 D31) 준비, 예약상한 계산$0.4986925(실제 청구 아님).
  **외부 실행 승인=false.** 사용자는 “개발에서 하는지, LLM은 어디서 보내는지”를 질문했을 뿐이다.
  로컬 코드·DB → OpenRouter → Xiaomi(mimo-v2.5-pro) 계획이며 개발 서버를 경유하지 않는다.
  실제 사용자 대화 미포함. 질문을 승인으로 세거나 과거 소진 승인/미실행 D30 요청을 재사용하지 말 것.
  승인 후 현재 모델/제공자/가격/파라미터를 재확인하고 최대32답변/$1/무재시도 범위만 실행한다.
  실제 답변/새 packet/원격 페이지는 아직 없다. 원격 사용자에게 localhost나 옛 N3 링크를
  새 D31 결과로 전달하지 않는다. 답변의 자연스러움·친밀도별/장기 대화·개인화는 미검증이다.
  새 DDL/개발 서버 접속·DB수정/배포/원격 게시/commit/push 없음. 병합 전 인간 검토 필요.
  [D31 변경·레퍼런스·검증·실행 위치](character-context-optimization-2026-09-09.md).
- **D30 / 성격별 DM 후보 적용 이력:** 공통 `persona-reference.ts`가 명시 kind의 용도를
  system/turn 입력에 보존한다. 제목 추정/원문 변환/캐릭터별 runtime 예외 없음.
  전용 로컬 DB의 말투4행·소이 칭찬 반응1행 본문 수정, 취향3행은 원문 보존 분류/분리.
  source45/조각72(상시33/조건부22/제외17), canon79 불변. 관리 API8회 실제 적용.
  D29 원문 스냅샷은 보존했지만 **현재 로컬 DB는 D29와 같지 않다. D29 초기화 재실행 금지.**
  baseline/data-only/renderer-only/combined 각24, 총96입력 검사. renderer-only는 보관
  Persona replay, 나머지는 실제 DB reader. 실제 모델 답변/외부 호출/새 사용자 판정0.
  제품381(DB skip0)+평가93=474검사 및 typecheck/lint/dead-code/build 통과.
  admin/backend/web 전체 검사는 이번에 재실행하지 않았다. 수정 전 역할 전달 회귀8실패 재현.
  private `evals/results/personality-local-2026-09-08/`에 4조건 evidence·8행 rollback입력·
  비교 예정32입력·공통 원래 성격/합성 문맥 설명 보관. 생성기2개는 보고서 참조, 결과 덮어쓰기 금지.
  새 OpenRouter/Xiaomi 32답변/$1/무재시도 외부 전송 승인 질문은 보냈으나 응답 미수신.
  paidExecutionApproved=false이며 과거 소진된 승인은 재사용하지 않는다. 승인 뒤 현재 제공자
  조건 재검증 후 baseline/combined 16쌍 실행; 조건당 모델설정 동일, 결과 전부 보관.
  입력 준비를 답변 품질 증거로 세지 않는다. 구체 취향 회수는 literal cue 한계가 남고
  성격 내부 다른 예문·직업 묘사는 일부 남는다. 실제 관계별/장기 채팅 검증은 아직 아니다.
  [D30 범위·적용 자료·테스트·한계](character-personality-local-2026-09-08.md).
  DDL/개발 서버/실제.env/배포/원격 게시/commit/push 없음. 병합 전 인간 검토 필요.
- **최신 D29 / 실제 DB 저장 구조와 로컬 검증:** 사용자가 DB 변경·테스트와 DDL을 명시 승인했다.
  canonical backend migration `20260908093302_persist_character_context`, admin mirror/API,
  agent Postgres reader를 변경했다. 기존 원문45개를 보존하고 새 child table에70조각,
  canon79개에 kind/injection/recall_keys 저장. 실제 관리 API124회 → DB → agent 대화 입력12건,
  DB 재시작 후12건 재검사. runtime manifest 없이 동작한다.
  전용 로컬 DB `127.0.0.1:55433/opod_persona_memory_local`, 컨테이너
  `opod-persona-memory-local-20260908`를 유지했다. 기존5433/개발 DB/실제.env/사용자 제출 불변.
  전체 테스트1174통과(agent372, 평가93, admin445+16E2E, backend149+99E2E), DB skip0.
  세 저장소 build/lint 및 schema drift 검사 통과. 무관 기존 파일 전체포맷 실패는 보고서 참조.
  실제 모델/외부embedding/사용자판정 추가0. 자연스러움 PASS 아님. commit/push/배포 없음.
  구조화된 본문은 기존PATCH 대신 structure API에서 원문+조각을 함께 수정해야 한다.
  migration 선행 필수이며 구조화 DB에 과거 manifest를 중복 적용하지 않는다. 아래 D28의
  “DB/DDL 없음, manifest 없으면 legacy”는 D28 당시 이력이며 D29 저장행에는 해당하지 않는다.
  [D29 결과·재현·제약](character-context-local-db-2026-09-08.md), backend PAVE 계획과
  private `evals/results/persisted-context-local-2026-09-08/`가 최신 증거다.
  다음은 DB reader 기반 실제 답변의 분리 조건 비교/사용자 검수이며 유료 호출 승인으로 확장하지 않는다.
- **D28 / 실제 Persona·canon 읽기 구조 구현·로컬 검증 이력:** 사용자가 다른 서비스 레퍼런스를
  찾아 두 구조를 수정하도록 요청했다. 추가 질문 없이 진행하라는 앞선 지시에 맞춰 범위를
  알리고 구현했다. D27의 라벨 목록만이 아니라 혼합 원문15개→40구간의 실제 분리, canon79개
  →상시11/조건부68(과거 사건26 전부 조건부), 공통 authored keyphrase selector와 사용자
  archival cosine 하한을 실제 제품 경로에 연결했다. source45블록/79canon과 기존 metadata는
  무손실 보존, 성격 신규 창작·캐릭터별 runtime 예외 없음. DB/DDL/새 current scene/정정·망각은 미포함.
  레퍼런스와 채택 경계는 연구11.23, 실제 구현 계약은 ADR0008 D28, 상세는 직접 개선 보고서 D28.
  `evals/results/structured-character-context-2026-09-08/`의 routing/source-spans/raw-typed/
  structured-personas/48capture/verification(총53파일)이 정본. 디렉터리0700/파일0600이다.
  생성기는 `evals/results/prepare-structured-character-context-2026-09-08.ts`, 기존 output에 재실행 금지.
  HTTP48입력(4명×일반4+과거회수1+주제종료1×전후)을 대조했다. 실제 모델 답변0이며
  사용자 개인화가 없는 합성 구조 검사다. 이를 N3/N4 실제 답변 비교나 장기 기억 품질 검사로 세지 않는다.
  원본2/사용자 제출3/N4파일74, 총79개의 hash를 보존했다. 미검수·draft·사용자 선택 모두 불변.
  `npm run check` 통과: 제품353/DB16 skip·평가93·웹42. 처음 DB 연동을 실행한 것으로 설명하지 않는다.
  새 모델/임베딩/DB접속/유료 호출/외부 LLM전송/제품 및 Site 배포/commit/push 없음.
  `PERSONA_ROUTING_MANIFEST_PATH`를 설정할 때 새 read model이 동작하며 실제 .env는 미변경이다.
  네 캐릭터만 담은 manifest를 전체 서비스에 활성화하지 말 것(미분류 source는 오류).
  소스가 바뀌면 hash 검증에서 실패하므로 분류 재생성·검토·재시작 필요. 경로 해제 시 legacyPersona복귀.
  사용자 기억은 별도로 `MEMORY_MIN_RELEVANCE=0`이 새 container 기본값이며 raw cosine<=0을
  제외한다. 의미적 무관함 전체를 판정하는 최적값이 아니고 실제 embedding 회수율은 미검증이다.
  custom store는 새 opts 계약 지원 확인 필요. debug canonCount는 주입 개수가 아닌 source개수다.
  selector는 마지막 발화의 literal cue만 읽고 lore4/canon4 제한; 의역/대명사/주제해소/토큰예산은 한계다.
  성격 내부 짧은 인용 예문은 남는다. 기존 공용 성격을 사용자별 학습 기억으로 덮어쓰지 않는다.
  다음 증거는 Persona-only/canon-only/gate-only/결합을 나눈 실제 답변과 사용자 검수다.
  분류/회수 적절성과 성격 유지의 인간 검토 전 병합하지 않는다. D27 N4는 별개 미실행 후보로
  보존돼 있으며 소진된 유료 실행 계약 재사용 금지. 추가 승인 질문을 반복하며 로컬 작업을
  멈추지는 말되 새로운 비용/배포/DDL까지 무제한 승인으로 해석하지 않는다.
- **D27 / N4 준비·로컬 검증 이력:** 사용자 “진행해”는 분류·실험 설정·로컬 검증 범위다.
  유료 호출/외부 전송/게시/제품 배포는 승인하지 않았다. 기존 snapshot 45블록을 용도별로
  목록화하고 기존 공통 RoutedPersonaStore를 재사용했다. 독립 examples 4블록만 주입 제외,
  나머지 성격·말투·canon79·제작 지침·공통 정책·N3 배치·모델 설정은 보존했다.
  혼합 블록의 예문/업무 소재는 여전히 남아 있으며 원문 분해나 성격 재작성은 하지 않았다.
  `evals/results/direct-naturalness-n4-offline-2026-09-08/`의 manifest/classification,
  before/after-routing/personas, review-briefs/review-contexts, first-batch, verification이 정본이다.
  입력32개/16쌍은 전=N3 후, 후=독립 예시 섹션 제거 외 전체 동일성을 확인했다.
  실제 답변0·비용0이며 FakeProvider 캡처를 모델 답변으로 세지 않는다. 이 디렉터리에
  `prepare-direct-naturalness-n4-2026-09-08.ts`를 재실행/덮어쓰지 않는다.
  기존 성격 문장의 원문 구간/hash 및 합성 관계·문맥 설명을 기존 personaBrief로 전달한다.
  Site의 review-source.mjs/test.mjs만 로컬 수정; 새 설명 표시 옵션은 과거 N1/N2/N3에
  적용하지 않았다. 기존 세 화면은 byte-identical, version3 이후 게시/commit/push 없음.
  합성 UI 검사만 완료했으며 N4 실제 packet/원격 페이지는 없다. 새 결과로 옛 링크를 주지 않는다.
  `npm run check` 통과(제품343/DB16 skip·평가92·웹42), 사이트 briefs/n1/n2/n3·빌드 통과.
  첫 실제 비교 예정은 모두 같은 present/‘뭐해?’·XP120/레벨2의 **4쌍/8답변**이다.
  출력 전 고정 선정이며 실행은 별도 범위 확인이 필요하다. 나머지12쌍은 로컬 검증용이다.
  원인/자연스러움/캐릭터성 개선은 미입증, 병합 전 예시 제외 범위와 발췌 대표성 검토 필요.
  기존 제출3개 hash·미검수/draft 보존; 개별 PASS/FAIL을 추정하지 않는다. 상세는 D27 보고서.
- **D26 / N2·N3 검수 접수·캐릭터성 진단:** 두 packet의 선택15건과 코멘트만1건을 접수했다.
  N2 선호3/N3 선호6/both_bad3/tie1/abstain2/not-reviewed1, 개별32답변은 전부 미검수다.
  두 제출은 같은 사용자1명의 draft다. packet-ac61392e8074/pair-006은 부정적 코멘트와
  끝 줄바꿈이 있어도 not-reviewed를 유지한다. 선호·both_bad를 개별 PASS/FAIL로 바꾸지 않는다.
  N3 실행 디렉터리의 `user-review-submissions-2026-09-08.json`과
  `user-review-receipt-2026-09-08.json`이 접수 정본이다. 입력 SHA256은
  a44b0a0c1ec3e46788490573d14c02c1014100c7438690b5ddb7117cc41e2887.
  기존 artifact108개·이전 사용자 제출·snapshot·제품 source 보존과 검수5건을 검증했다.
  사용자 전체 관찰은 ‘캐릭터들의 성격이 두드러지지 않는다’. 설정은 9~12블록으로 비어 있지
  않으나 문제 예시와 제작 지침이 이번 frozen 입력에 그대로 들어간다. 인사/셀렉의 source와
  출력 겹침을 확인했다. 공통 제약 영향은 가설이며 인과 확정이나 성격 개별 판정은 하지 않는다.
  후속 제안: 공통 구조 안에서 각 캐릭터의 판단·반응과 제작 자료를 구분하고 문제 예시 주입을
  별도 변수로 점검. 본문 변경과 구조 변경을 한 번에 섞지 않는다. 검수는 이름만이 아니라
  source-backed 성격·관계 설명이 필요하나 정답 힌트를 주지 않는다. 이번에 구현/게시하지 않았다.
  상세 근거·모든 코멘트·한계는 직접 개선 보고서 D26. 새 모델/DB/제품·사이트 변경은 없음.
  아래 D25의 검수 대기는 과거 이력이며 이미 받은 선택을 다시 요구하지 않는다.
- **D25 / N2·N3 실제 비교 실행 이력:** 새 명시적 같은4명·OpenRouter/Xiaomi·
  최대32답변/$1·무재시도·비공개 게시 요청에 “진행해” 승인. 32시도/32답변/16쌍 완료,
  청구 **$0.023467782**, 재시도/추가 호출 0. 수정 전=N2, 후=N3이며 배치 순서 외 차이는 없다.
  양 조건 120초, 과거 D22의 60초 중단 run과 합치지 않는다. source·사용자 제출 hash 보존.
  `evals/results/direct-naturalness-n3-approved-2026-09-08/`의 manifest/completed/verification을
  먼저 읽는다. 실행 계약은 소진됐으며 runner를 재실행하지 않는다. 21건 관계 태그 누락과
  reasoning payload 32건/usage reasoning_tokens 0도 기록했다. 제품 추가 변경·배포·DB 쓰기 없음.
  [본인 전용 N2/N3 검수](https://opod-chat-review-sep08.mute1478.chatgpt.site/n3.html)의 새 packet은
  `packet-4d0afc541f92`, `packet-ac61392e8074`이며 각8쌍이다. 개별32/쌍16 모두 미검수,
  기존 N1/N2 사용자 판정은 새 출력에 적용하지 않는다. 원문·입력·비용·매핑 검증과 회귀5+13건,
  사이트 세회차 검사/빌드 통과. 새로운 브라우저 시각 검수·native WebMCP 실검증은 없음.
  다음은 사용자가 `판정 복사` 후 보내는 선택·코멘트 접수다. 선호→PASS 추정 금지,
  배치 가설 unknown·제품 병합 전 사용자 품질 검수 필요. 아래 D24의 호출0은 이전 구현 이력이다.
  사이트 version 3 게시 성공·owner-only 재확인·비로그인 HTTP401, 사이트 소스 HEAD는
  `d7af8184b95c71b8eb812bba9a0e36435b820898`이다. 기존 N1/N2 산출물은 byte-identical.
  원격 앱 열기는 queued였고 직접 HTTPS 링크가 인계 수단이다. 제품 변경들은 미커밋 상태다.
- **D24 / N3 배치 후보 구현 이력:** “다음 진행해”에 따라 공통 `withTurnContext`의 결합 순서만
  `[발화 + context]`에서 `[context + 발화]`로 바꿨다. 지침·Persona·기억 원문·역할·이전 대화·
  모델 설정은 그대로이며 요청 크기 차이는 0byte다. 원인 가설은 unknown, 품질 개선 미입증이다.
  직접 관련 87건 및 전체 검사(제품 343/DB 16 skip·평가 92·웹 42) 통과, 실제 HTTP 입력
  16쌍에서 N2 후=N3 전과 순서 외 동일성을 확인했다. 입력과 verification은
  `evals/results/direct-naturalness-n3-offline-2026-09-08/`에 있고 실제 답변 생성은 0회다.
  두 사용자 제출 hash 불변, 내부 지침이 기억 저장 원문에 섞이지 않는 경계도 유지했다.
  ADR 0007을 미배포 배치 후보에 맞춰 갱신했다. 기존 user-message envelope 안의 구분이며
  system-role 격리나 보안 개선으로 설명하지 않는다. 병합 전 사용자 답변 검수가 필요하다.
  새 유료 비교는 별도 같은4명·OpenRouter/Xiaomi·최대32답변/$1 범위 확인 후 진행한다.
  양 조건 동일 120초·재시도0 안이며 D22 중단 run을 임의 재개/덮어쓰지 않는다.
  이번 제품/사이트 배포·DB 변경·새 유료 호출·commit/push는 없다.
- **최신 D23 / N2 부분 검수 접수:** 사용자 1명의 packet `packet-e314b9acb491` 4쌍 선택을
  원문 그대로 받았다. 서린 현재 근황 A(N2), 한소이 현재 근황 B(N2), 나희 알람 동의 both_bad
  (“둘다 문맥이 이상함”), 권도건 인사 A(N1)다. N2 2/N1 1 선호는 합격률·전체 개선이 아니다.
  draft·개별 8건 not-reviewed·빈 tags/evidenceTurns/note를 유지했다. 선택 이유 보충·개별
  PASS/FAIL 추정·gold 승격은 하지 않는다. D20 기존 16쌍 선택도 그대로다.
  N2 실행 디렉터리의 `user-review-submissions-2026-09-08.json`과
  `user-review-receipt-2026-09-08.json`이 접수 정본이다. 기존 생성 artifact는 변경하지 않았다.
  schema/원문/조건 가림 대응·기존 hash 불변·검수 회귀 5건을 검증했다. 제품 변경·새 호출·
  DB 쓰기·웹 재게시·commit/push는 없다. 아래 D22의 검수 대기는 당시 이력으로 읽는다.
  전체 32답변 비교·화제 중단 문맥은 미완료이며 이미 받은 4쌍 판정을 다시 요청하지 않는다.
- **D22 / N2 실제 비교 부분 실행 이력:** 새 최대 32답변/$1·4명·OpenRouter/Xiaomi 범위에
  사용자가 “진행해”로 승인했다. 9시도·8본문 확보 뒤 9번째 요청이 60초 시간 초과로 중단됐다.
  23개는 미시도, 재시도/재개 0. 확인 청구 $0.01995432, 시간 초과 건 청구 미확인이다.
  `evals/results/direct-naturalness-n2-approved-2026-09-08/`의 `incomplete.json`과
  `verification-partial.json`을 먼저 읽는다. 이 runner를 재실행하거나 완료로 바꾸지 않는다.
  단일 packet `packet-e314b9acb491`은 8답변/4쌍이며 전부 미검수다. 각 캐릭터 한 문맥뿐이고
  화제 중단 문맥은 없다. 원문·짝·미검수·기존 판정 hash 불변 검증 및 검수 5건/태그 13건 통과.
  제품 추가 수정·DB 쓰기·DDL·제품 배포는 없다. 아래 D21의 호출 0은 수정 당시 이력이다.
  [본인 전용 N2 부분 검수](https://opod-chat-review-sep08.mute1478.chatgpt.site/n2.html) 게시 완료
  (Sites version 2). 기존 루트/N1 화면·판정 저장은 보존됐으며 새 4쌍만 별도로 검수한다.
  `판정 복사` 후 이 대화에 붙여 넣는 흐름이다. 웹 게시 성공을 모델 비교 완료로 세지 않는다.
- **D21 / N2 구현 이력:** D20 뒤 “진행해”에 따라 공통 참조 영역 표시와 반응 지침을 수정했다.
  성격에 따른 화제 중단 반응, 말투 연속성, 평이한 어휘, 인사와 예시의 사건·관계 구분이 대상이다.
  제품 변경은 `system-prompt.ts`·`turn-context.ts`와 관련 기존 테스트뿐이다. 실제 네 캐릭터의
  16쌍 입력을 비교해 N1 후와 N2 전 일치, 41블록/79canon·history·설정 보존을 확인했다.
  `npm run check` 전체 통과(제품 342/DB 16 skip, 평가 92, 웹 42). 실제 모델 호출은 0이다.
  N2는 **구현·구조 검증 완료 / 답변 품질 미검증**이며 상세는 [N2 기록](character-chat-direct-naturalness-2026-09-08.md#n2--검수-후-공통-입력-구성반응-지침-수정).
  입력: `evals/results/direct-naturalness-n2-offline-2026-09-08/`. 기존 사용자 판정·N1 결과를 보존했다.
  유료 32회 실행 계약은 소진됐으므로 N2 실모델 비교를 이전 승인으로 재실행하지 않는다.
- **최신 D20: 사용자 pairwise 검수 접수.** 두 packet의 16쌍 중 한쪽 선호 9(수정 전 5/후 4),
  둘 다 부적절 4, 비슷함 1, 판단 보류 2. 두 submission은 draft이고 개별 32대화는 전부
  not-reviewed다. 선호를 PASS로, both_bad를 개별 FAIL로 변환하지 않는다. 아래 ‘사용자 검수 대기’는
  D20 이전 이력이며 앞으로는 이미 받은 선택을 다시 요청하지 않는다.
  원문/검증 기록은 실행 디렉터리의 `user-review-submissions-2026-09-08.json`과
  `user-review-receipt-2026-09-08.json`, 해석 경계는 [보고서 D20](character-chat-direct-naturalness-2026-09-08.md#사용자-검수-반영--d20).
  성격에 따른 화제 중단 반응, 친밀도에 따른 인사, 갑작스러운 말투 변화와 어휘·문맥 지적을
  캐릭터별 정답 문장이나 전역 말투 금지 규칙으로 바꾸지 않는다. 아직 개선 완료는 입증되지 않았다.
- **원격 검수(D19):** [본인 전용 검수 링크](https://opod-chat-review-sep08.mute1478.chatgpt.site).
  “원격이라 못봐 볼 수 있게 해” 요청으로 기존 32답변/16쌍 화면만 독립 Sites에 게시 완료했다.
  `판정 복사` 후 이 대화에 붙여 넣으면 된다. 저장은 브라우저별이며 자동 제출/기기 동기화는 없다.
  추가 모델·제품 배포·DB 변경은 없고 사용자 검수는 여전히 대기다. 독립 사이트 checkout은
  `/Users/hongtaeho/opod/opod-chat-review-site`, project는 해당 `.openai/hosting.json`을 재사용한다.
- **최신 D18: 사용자가 명시적 32답변/$1 요청에 “ㅇㅇ”로 승인하여 비교 실행 완료.**
  고정 provider 요청 32개를 재생했고 전부 Xiaomi·지정 모델·정상 종료·본문을 확인했다.
  청구액 $0.034232076, retry/추가 모델 호출 0. `evals/results/direct-naturalness-approved-2026-09-08/`
  에 원문·private key와 8쌍씩 두 검수 묶음이 있다. 이 대화의 `opod-direct-chat-review` 화면으로
  사용자 1인의 판정을 받는다. 과거 실행 차단은 해소됐으며 현재는 사용자 원문 검수 대기다.
  reasoning payload 32개 존재/usage reasoning_tokens 전부 0, 관계 태그 15개 누락을 감추지 않는다.
  추가 모델 호출·DDL·배포 권한으로 확대하지 말고, 생성 성공을 품질 PASS로 세지 않는다.
- **최신 우선순위(D17): 정정·망각과 신규 DDL은 보류. ‘뜬금없고 어색한 대화’ 직접 개선이 먼저다.**
  [N1 보고서](character-chat-direct-naturalness-2026-09-08.md)의 공통 지침 충돌 수정과 관련 회귀
  69건, 제품 로컬 DB 포함 358건 검증을 완료했다. 4명×4문맥 전후 **입력** 32개를 오프라인으로
  확인했으며 실제 모델 답변은 아니다. 당시 신규 32답변/$1 실행은 외부 전송·비용 승인 검토에서
  차단됐으나 후속 D18 승인으로 실행 완료했다. 당시의 0회와 이번 32회를 구분한다.
  실제 사용자 검수가 없으므로 품질 PASS 금지.
  최종 `npm run check` 전체 통과(평가 92건, 웹 42건, 기존 coverage·타입·빌드 기준 유지).
  아래 M1~M3/DDL 기록은 이력으로 보존하고, DDL을 현재 우선 blocker로 되살리지 않는다.
- 현재 단계: M1 기억 저장 입구, C1 canon 읽기 구조, S2 oracle 비교, M2 겹치는 Summary 작업과 **M3 빈/초과 파생 기억의 실패·재시도** 구현·검증 완료. 기존 실제 모델 smoke 12회는 다른 환경의 완료 이력이며 원문은 이 checkout에서 미확보. 사용자 검수·실제 선택기·정정/망각은 미완료
- 현재 계획: [구조 실험 계약과 실행 순서](../character-chat-products-persona-memory-research-2026-09-03.md#10-실험-계약--품질과-원인을-함께-확인한다-2026-09-07-수정), 같은 문서 11절
- 최종 완료 기준: 같은 계획의 **10.6절 G1~G7**. 후속 목표 진행 요청으로 v1을 작업 기준으로 채택했다. 현재 최종 gate는 모두 미검증이며 추가 유료 실행·DB 변경·배포 승인이 아니다.
- 최신 실행 기록: 같은 계획 **11.6~11.11절**. 사용자 “끝날때까지 물어보지말고 그냥 진행해” 지시로 구현했다. 이전 M1 승인 대기 문구를 현행 blocker로 되살리지 않는다.
- 새 읽기 전용 snapshot: **22:53:48 KST**, 활성 캐릭터 4명/Persona 45개/캐릭터 기억 79개. `evals/results/character-source-recovery-2026-09-07/`. 기존 S1 분리·smoke 원문 복구와 구분한다. 접속 경로를 복구했으므로 사용자에게 `.env`나 접속 파일을 다시 묻지 않는다.
- 구현 요약과 남은 일: [이번 구현 보고서](character-chat-memory-ingestion-and-canon-2026-09-07.md). 최종 G1~G7은 여전히 미검증이며 구조화 자체를 자연스러움 PASS로 세지 않는다.
- **2026-09-08 M2 기록:** [M2 보고서](character-chat-summary-coverage-2026-09-08.md), 계획 11.8~11.9절.
  실제 4메시지를 6개로 합산하던 Summary 결함을 수정했다. 새 job의 `turnsStartOffset`이 큐 JSON과
  worker parser를 거쳐 요약에 전달되고, 이미 처리된 suffix는 다시 더하지 않는다. 제품 344건
  (DB 통합 16 포함)/eval 92건과 타입·lint·build·dead-code 통과. lifecycle `POLICY-FAIL`은 유지한다.
- 평가의 batched 모드에서 앞 job을 생략하던 우회를 제거했다. `consolidationQueuePolicy`를 확인하고
  과거 결과와 동일 실행 조건으로 섞지 않는다. 구형 offset 없는 job은 기존 방식이며, 기존 손상
  Summary를 자동 정리하지 않았다. 개발 DB 쓰기·DDL·유료 모델·배포·push 없음.
- **최신 전체 검사와 실행 경계:** [M3 포함 보고서·DDL 제안](character-chat-completion-boundary-2026-09-08.md),
  계획 11.10~11.12절. 빈 Summary의 완료 처리와 Core의 문장 중간 잘림/빈 값 정상 종료를 수정했다.
  제품 DB 포함 **348건**, eval **92건**, 웹 **42건** 통과. 제품/평가/웹 타입 검사, lint·dead-code,
  제품/웹 빌드 통과. 초기 웹 coverage 88.14% 미달 뒤 누락된 캐릭터 목록의 ID/장애 계약 5건을
  추가했고 **93.55%**로 기준 통과. `npm run check` 최종 전체 통과. 웹 제품 소스/기준 미변경이다.
- 새 lifecycle DDL은 검토용 제안만 작성했다. 그 안의 상태/세대/출처/원장, legacy 및 rollback
  동작을 확정 정책이나 완료 구현으로 취급하지 않는다. 신규 DDL과 유료 실행·배포의 권한 경계,
  사용자 원문 검수 부재는 다음 진행에 필요한 외부 조건이다. 반복되는 안전한 작은 수정 결과를
  매번 최종 답변으로 끝내지 말라는 최신 사용자 지시도 유지한다.

## 다음 세션이 먼저 알아야 할 결론

이번 작업은 권도건이나 특정 캐릭터의 말투 패치가 아니다. 모든 캐릭터가 공유하는 prompt/context
경로를 개선하는 작업이다. 캐릭터 이름, 직업, 취미, 대표 소재나 특정 문장을 runtime 분기 조건으로
추가하면 안 된다.

자동 평가는 최종 품질 판정자가 아니다. 과거 judge가 사용자가 `뜬금없음`, `어색함`, `FAILURE`로
판정한 문장을 PASS 처리했기 때문에, 대화 자연스러움의 최종 판정은 사용자가 원문 transcript를 보고
내린다. 구조 preflight 성공을 대화 품질 PASS로 승격하지 않는다.

현재 검증한 것은 저장 입구·canon 읽기·Persona source 배치와 N1 공통 답변 지침 계약이며 실제 모델 12회의 요청/응답 연결은 이전 실행 이력이다. 실제 모델의 자연스러운 한국어,
캐릭터성 유지, 뜬금없는 자기소개·직업·게시물 소재 감소는 아직 증명하지 않았다.

2026-09-07 재검토에서 전량 주입을 유일한 원인으로 단정한 표현을 수정했다. character canon은
Router 밖에서 여전히 전량 주입되고, 실제 selector도 기본 제공되지 않는다. manifest만 만들면
실제 Routed A/B가 준비된 것으로 간주하지 않는다. 관련 source 선택을 사전에 사람이 대신하는
진단과 자동 선택 경로의 성능을 구분하며, 전자의 개선만으로 서비스 적용을 결정하지 않는다.

## 사용자 검수에서 확정된 실패 기준

- 사용자가 꺼내지 않은 날씨, 위치, 방문 목적, 직업, 촬영, 게시물을 먼저 화제로 삼지 않는다.
- Persona·Memory는 반응 방식과 의견을 형성하는 배경이지, 매 턴 보여줘야 하는 체크리스트가 아니다.
- 상품 설명, 게시물 캡션, 상담원 응대, 업무 jargon처럼 들리는 문장을 피한다.
- 직전 발화와 연결되지 않은 질문·자기 노출·주제 전환은 실패다.
- 특정 대표 소재를 계속 반복해 캐릭터성을 증명하려 하지 않는다.
- 반말과 존댓말 혼용은 자동 실패가 아니다. Persona와 관계에 맞으면 허용한다.
- 문법적으로 유창하다는 이유만으로 자연스럽다고 판정하지 않는다.

상세 사용자 코멘트와 판정 보존 위치:

- [`character-chat-p0-human-review-2026-09-02.md`](character-chat-p0-human-review-2026-09-02.md)
- [`character-chat-p0-user-review-policy-2026-09-03.md`](character-chat-p0-user-review-policy-2026-09-03.md)
- [`naturalness-human-review-guide.md`](../evals/naturalness-human-review-guide.md)

## 완료된 작업

### 조사와 P0 평가 기반

- 캐릭터 챗 architecture, Persona/Memory 관리, 자연스러운 대화 설계 원칙을 조사했다.
- 사용자 지적을 공통 자연스러움 rubric과 shared prompt 원칙으로 옮겼다.
- 모든 runtime character를 같은 scenario에 교차 실행하는 diagnostic suite를 만들었다.
- 자동 PASS와 사용자 판정을 분리하고, blind review용 artifact 경로를 만들었다.
- 모델·prompt hash·context source provenance 누락이 품질 결과로 통과하지 못하게 했다.

관련 문서:

- [`character-chat-architecture-research-2026-09-02.md`](../character-chat-architecture-research-2026-09-02.md)
- [`character-chat-products-persona-memory-research-2026-09-03.md`](../character-chat-products-persona-memory-research-2026-09-03.md)
- [`character-chat-p0-baseline-plan-2026-09-02.md`](../character-chat-p0-baseline-plan-2026-09-02.md)
- [`character-chat-p0-before-after-2026-09-03.md`](character-chat-p0-before-after-2026-09-03.md)

### P1-0 — Memory fixture와 provenance

- 실제 in-process `MemoryStore`에 lifecycle fixture를 seed하고 retrieval·injection provenance를
  기록하는 구조 probe를 만들었다.
- 현행 unfiltered top-K가 `superseded`, `forgotten`, `stale` record를 주입하는 기준선 실패를
  숨기지 않았다.
- 구조 preflight와 품질 PASS를 분리했다.

상세 결과:

- [`character-chat-p1-0-memory-fixture-provenance-2026-09-07.md`](character-chat-p1-0-memory-fixture-provenance-2026-09-07.md)

### P1-1 — 공용 Persona Router

- Persona block read model에 stable block ID, `kind`, `injection`을 추가했다.
- `RoutedPersonaStore`가 제목이 아니라 stable block ID로 strict manifest를 결합한다.
- `routePersona`가 네 prompt 경로를 단독 소유한다.
  - `always`: stable system prompt
  - `start_only`: 첫 assistant 응답의 tail context
  - `retrieved`: relevance selector가 고른 현재 턴의 tail context
  - `never_prompt`: 미주입
- 누락되거나 중복된 explicit mapping은 실패한다. 매핑 없는 production Store는 기존 동작을 유지한다.
- selector에는 캐릭터 ID, 현재 query, `retrieved` 후보만 전달한다. `never_prompt` 원문은 selector에도
  전달하지 않는다.
- 동적 Persona가 바뀌어도 stable prompt hash는 유지된다.
- debug provenance는 source ID와 route metadata만 포함하고 title/content는 포함하지 않는다.

동일 3턴을 사용한 합성 Persona 2개의 구조 A/B 결과:

| 관측 | Legacy | Routed |
| --- | ---: | ---: |
| 중립 첫 턴의 불필요 source | 4 | 0 |
| 첫 턴 이후 `start_only` 잔류 | 4 | 0 |
| `never_prompt` 누출 | 6 | 0 |
| 관련 질문의 lore 주입 | 해당 없음 | 2/2 |

이 결과의 `qualityPassed`, `passed`, `certificationEligible`은 의도적으로 모두 `false`다.

상세 결과와 결정:

- [`character-chat-p1-1-persona-router-2026-09-07.md`](character-chat-p1-1-persona-router-2026-09-07.md)
- [`0008-explicit-persona-routing.md`](../adr/0008-explicit-persona-routing.md)
- [`persona-memory-plan.md`](../persona-memory-plan.md)

## 현재 데이터 상태와 차단점

- 최초 인계 당시 로컬 Postgres 세 테이블은 0행이었다. 이 기록은 개발 DB가 비었다는 뜻이 아니다.
- 2026-09-07 14:49 KST 개발 DB에 접속해 `BEGIN READ ONLY`와 `transaction_read_only=on`으로
  조회했다. 전체 행 수는 `characters=4`, `character_personas=45`, `character_memories=79`였다.
  트랜잭션은 ROLLBACK으로 끝났고 데이터·schema는 변경하지 않았다.
- 이 count에는 활성/삭제 조건을 적용하지 않았다. 이전 snapshot의 활성 행 수와 같다는 사실만으로
  활성 수·원문·version이 동일하다고 주장하지 않는다. 해당 조건과 hash는 snapshot 준비 시 확인한다.
- 접속 불가는 해소됐다. 14:49 확인 이후의 격리 snapshot과 원문 조사 진행은 아래 S1 결과를 따른다.
  실제 selector 연결·반복 본 비교는 미실행이며 첫 모델 smoke는 아래 후속 결과를 따른다.
  접속 정보·인증 파일 내용은 문서나 artifact에 기록하지 않는다.
- character canon memory는 여전히 전량 stable prompt에 들어간다. P1-1은 이 문제를 해결하지 않는다.

### 후속 S1 읽기 전용 집계 (2026-09-07)

후속 진행 요청에 따라 `status=active`, `deleted_at IS NULL`을 적용해 확인했다. 활성 캐릭터
4명·Persona 45개·character memory 79개이며 삭제된 Persona/Memory는 0개다. 원문을 조회
결과로 내보내지 않고 집계만 수행했다.

| 항목 | 결과 |
| --- | ---: |
| Persona 원문 총 문자 수 / 최대 블록 | 16,375 / 1,405 |
| Memory 원문 총 문자 수 / 최대 항목 | 4,536 / 356 |
| legacy greeting 제외 / 나머지 Persona | 4 / 41 |
| 빈 Persona | 0 |
| Memory event / fact / goal | 26 / 13 / 7 |
| Memory preference / relationship / routine | 16 / 3 / 14 |
| `auto:` reason | event 중 1개 |

이 집계 당시 개발 DB의 기존 `type`은 Agent adapter가 읽지 않았다. 후속 C1에서 metadata를
보존하도록 수정했다. type만으로 의미·유효기간·현재 상태를 판단하지 않는다.

원문을 gitignore 대상 `evals/results/s1-source-audit-2026-09-07/source-snapshot.json`으로
격리하는 작업은 자동 승인 검토가 민감한 내부 원문의 로컬 저장에 명시적 승인이 필요하다는
이유로 처음에는 거부했다. 이후 사용자가 해당 저장·분석을 명시적으로 승인했고, 15:22:21 KST에
read-only / repeatable-read snapshot을 생성했다. 개발 DB 쓰기와 실제 사용자 데이터 반입은 없다.

### S1 원문 조사 완료

[S1 보고서](character-chat-s1-source-audit-2026-09-07.md)에 결과를 기록했다. 원문과 ID별 조사표는
위 ignored 디렉터리에만 있다. Persona 45개·Memory 79개 모두 원문을 검토했다.

- `always` 18 / `retrieved` 8 / `never_prompt` 7개 후보와 미확정 12개를 구분했다.
- 조사 당시 미확정은 혼합 목적 8개, examples 4개였다. 이후 혼합 8개 분리는 승인·구현했고,
  examples 4개와 전체 strict manifest는 아직 준비 전이다. 조사 완료를 전체 routing 준비 완료와 혼동하지 않는다.
- 승인된 8개/22구간을 `eval:persona-projection`으로 실험 입력에 적용했다. 원본 45개에서 59개로
  바뀌며 구간 정책은 `always` 11 / `never_prompt` 8 / `retrieved` 3이다. 다른 37개·examples 4개·
  canon 79개는 그대로다. 원문 재작성·DB 분할·제품 runtime 변경은 없다.
- 최종 artifact는 ignored 경로 `evals/results/s1-source-audit-2026-09-07/applied-mixed-blocks-final/`에
  있다. source 원문 복원과 4명 × 3조건의 배치·stable hash 검증을 통과했다. 품질 PASS는 아니다.
- 정적 examples에 과거 실패 인사와 무근거 현재 활동·공유 기억 답변이 존재함을 확인했다.
  examples 처리와 혼합 블록 분리를 같은 변경으로 묶지 않는다.

### Examples 후속 검토와 비교 입력 준비

- [후속 보고서](character-chat-s1-examples-review-2026-09-07.md)에 4개 블록·54문답의 검토를 정리했다.
  일부 표현은 voice/boundaries에도 남아 있어 예시만 제외하면 해결된다고 단정하지 않는다.
- A 원문 45개, B 승인된 혼합 분리 59개, C B와 동일하되 네 예시 source만 `never_prompt`인
  입력을 준비했다. C도 예시 내용을 보존하며 다른 55개 블록과 canon 79개는 그대로다.
- `candidate-without-examples.json`, `examples-comparison-cases.json`, `examples-ablation-preflight.json`은
  기존 ignored source 디렉터리에 있다. C는 검토용 후보이며 제품에 적용한 정책이 아니다.
- 기존 `ChatService.prepare`로 4명 × 8상황 × 3조건 96건을 검증했다. 고정 시각, Bond 미추적,
  tools·사용자 Memory fixture 없음, optional 선택 0의 진단이다. 모델·embedding 호출은 0회다.
- B↔C는 예시 노출만 비교한다. A↔C로 두 변경을 섞지 않으며 실제 선택기나 자연스러움 성공으로
  표현하지 않는다. 이 입력 준비 당시에는 제품 코드·정식 테스트를 변경하지 않았다.

## 고정 입력 모델 경로 연결과 현재 실행안

- 후속 진행 요청으로 `eval:persona-comparison`을 구현했다. 고정 Persona/case hash, fresh target,
  clock, hidden state, 조건별 prompt provenance를 기존 HTTP/provider 경로에서 검사한다.
  클라이언트 재시도 0회, tools/embedding 없음, 실패·잘린 응답에서 중단하고 앞선 응답을 보존한다.
- 실제 source CLI 합성 응답 96건 통과, 외부 모델 0회. 두 review 패킷은 각각 32쌍이며
  같은 캐릭터와 같은 prefix끼리만 비교한다. 원문·이름은 그대로, 조건·모델은 가린다.
  사용자 1인 검수용이며 `both_bad`를 지원한다. 기존 2인 agreement 집계는 사용하지 않는다.
- 사용자가 설정이 DB에 있다고 알려줘 `opod.admin_settings`를 읽기 전용 확인했다.
  `agent`의 OpenRouter `xiaomi/mimo-v2.5-pro`가 선택되며 API 키는 존재 여부만 확인했다.
  `.env` 경로를 다시 묻지 않는다. 실제 실행 때 DB 설정을 메모리에서 읽고 고정하되 키는 출력·저장하지 않는다.
- 기존 ignored source 디렉터리의 `comparison-smoke-manifest.json`과
  `comparison-smoke-execution-contract.json`이 12회 실행안이다. 인사 1상황 × 4명 × 3조건,
  temperature 1 / top_p 0.95 / max_tokens 8192 / 재시도 0이다. 현재 공개 가격을 적용한
  사전 보수적 추산은 약 $0.24이며 강제 달러 한도는 아니다. 사용자가 이 범위를 승인한 뒤
  17:40:42 KST에 12회 모두 정상 종료했다. 실제 청구액은 $0.020053869다.
- OpenRouter 자동 routing/reasoning 기본값을 사용하는 smoke는 연결 확인과 초기 검토 범위다.
  본 비교 전에 upstream/reasoning 조건을 정해야 하며 288회로 자동 확대하지 않는다.
  자세한 근거·한계는 [연결 검증과 실행안](character-chat-s1-examples-review-2026-09-07.md)에 있다.
- 실제 모델 artifact는 `comparison-smoke-model-run/`에 있다. 12개 response ID와 token count,
  preflight와 동일한 prompt metadata, source/case hash, 검수 8쌍, 권한·gitignore 등 32개 검증을 통과했다.
  `review-1.md`와 `review-2.md`가 사용자 검수 파일이며 private key는 최초 검수 때 보여주지 않는다.
- metadata GET 12회에서 Xiaomi 7 / GMICloud 2 / DigitalOcean·DeepInfra·Novita 각 1회를 확인했다.
  실제 모델 정식 ID는 모두 `xiaomi/mimo-v2.5-pro-20260422`로 공개 alias mapping과 일치한다.
  reasoning 보고값 차이와 인사 1상황·1반복의 제한 때문에 구조 개선의 효과로 판정하지 않는다.
- 최초 계약 JSON의 승인 대기 상태는 역사적 기록이다. `comparison-smoke-run-authorization.json`에
  후속 사용자 승인이 있고 실행도 끝났으므로 같은 12회 승인을 다시 묻거나 자동 재실행하지 않는다.

## 다음 실행 순서

아래 과거 S1 순서는 원래 artifact가 있는 환경의 이력이다. **현재 checkout의 우선 상태**는 다음과 같다.

1. 계획 11.7~11.9절과 최신 M2 보고서를 먼저 읽는다. M1/C1/oracle/M2 구현을 다시 시작하거나 승인 대기로 돌리지 않는다.
2. 새 snapshot은 확보했지만 이전 12응답·8개/22구간 분리 artifact는 복구되지 않았다. 새 56건의
   `oracle-preflight`는 합성 응답이며 원래 smoke나 인간 검수 자료를 대신하지 않는다.
3. Persona는 조건을 통제한 실제 응답과 사용자 원문 검수, 이후 실제 선택기/holdout 검증이 남는다.
   제공사/reasoning 혼합 smoke를 최종 기준선으로 삼거나 사용자 판정을 생성하지 않는다.
4. 독립된 사용자 Memory 후속은 실제 근거 연결·정정/망각의 영속 상태 계약이다. fixture만 고치지
   말고 Core/Summary/history/대기 job까지 범위를 확인한다. backend의 기존 dirty 변경을 보존한다.
5. 현재 branch 변경은 미커밋·미배포 상태다. 병합 전 공유 데이터 계약과 저장 실패 경계를 검토해야 한다.

### 이전 S1 작업 순서 — 해당 원본이 확보된 환경에서만 사용

최종 완료 여부는 계획 10.6절을 따른다. 아래 소규모 진단 순서는 유지하고, 최종 검증 규모를 곧바로
실행하지 않는다. 사용자 자연스러움·개성 판정과 자동 구조 검사를 분리하며 미검수를 PASS로 채우지 않는다.

1. 현재 계획 10~11절과 S1 보고서를 읽는다. 원문 저장 승인은 해소됐고 15:22 snapshot이 있다.
   불필요하게 재조회하지 않는다. 승인된 모델 12회는 완료됐고 DB 쓰기·DDL은 하지 않았다.
2. 혼합 8개/22구간 분리는 승인·완료됐다. `source-projection.json`과 최종 artifact를 사용한다.
   기존 `mixed-block-proposal.*`의 승인 전 status는 역사적 기록이며 승인을 다시 묻지 않는다.
3. 완료된 smoke의 조건을 가린 두 패킷을 사용자가 검수한다. 사용자 답변을 생성하거나
   대신 PASS를 넣지 않는다. 최종 제품 정책·실제 selector는 후속 결정이다.
4. smoke 원문 검토 뒤 제공사/reasoning을 통제한 본 비교 조건을 확정해 Legacy와 사전 선택 Routed를 같은
   모델·원문·canon·hidden state로 새로 생성한다. 첫 국소 비교를 전체 mapping 완성까지 미루지 않는다.
   단순 fixture selector나 기본 empty 선택을 실제 retrieval 검증으로 세지 않는다.
5. 사용자 검수에서 이득이 보이면 실제 selector와 미사용 case, 긴 대화에서 재검증한다.
   조건과 source badge는 최초 판단 때 가리며 캐릭터성·회상·한국어 회귀를 함께 본다.
6. 이득이 없거나 혼재하면 canon, context 순서, 시간/Bond 지침, 표현·모델 중 근거가 가리키는
   원인을 하나씩 검증한다. Memory Gate와 Current State를 자동으로 다음 구현에 넣지 않는다.
7. 확인된 효과가 유지되는 변경만 적용 후보로 남긴다. schema 변경은 최소 필요와 rollback을
   별도로 승인받으며, Persona/character lore/사용자 Memory 효과를 하나로 합쳐 주장하지 않는다.

## 재현과 검증 명령

```bash
npm run eval:persona-router
npm test
npm run test:eval
npm run typecheck
npm run typecheck:eval
npm run lint
npm run build
npm run dead-code
```

최신 2026-09-08 검증은 위 M2 보고서를 따른다. 아래는 2026-09-07 구현 검증 이력이다.

- `test:coverage`: runtime 323 통과, DB 조건부 15 skip, coverage 92.35%로 gate 통과.
- `test:eval:coverage`: 91 통과, 기존 coverage 집계 범위 85.16%로 gate 통과.
- 최종 로컬 DB 연결 전체 실행: **338건 전부 통과**(기존 Memory 통합 14건 + 신규 canon 1건 포함). canon fixture는
  단일 트랜잭션에서 ROLLBACK해 테스트 데이터가 남지 않는다. 개발 DB 쓰기·DDL 없음.
- runtime/eval typecheck, lint, build, dead-code 통과. 이번 턴의 웹 typecheck와 37개 테스트도 통과했다.
- 실제 source oracle 경로 56건·외부 모델 0회, 4명/79개 canon 레코드와 기존 prompt의 byte 동일성 통과.
- memory 구조 probe는 `STRUCTURE-PASS POLICY-FAIL` 유지, Persona routing 구조 probe는 통과.
- 새 유료 호출·배포·push 없음. 원문과 private artifact는 Git 밖에 두었다.

이전 실제 모델 검증 결과(다른 환경에서 남긴 완료 이력):

- 승인된 CLI `run --max-calls 12` exit 0. 12회 모두 같은 요청 모델, finish reason `stop`.
- prompt metadata가 기존 합성 preflight와 동일하고 실제 artifact 독립 검증 32개 통과.
- generation GET 12회의 청구액·제공사·정식 모델 ID·native token count를 대조했다. 추가 모델 생성 0회.
- 해당 모델 실행 턴은 artifact와 결과/계획 문서만 갱신했다. 당시 제품/eval 코드 변경이 없어 전체 테스트를 재실행하지 않았다. 이후 구현 턴의 회귀 결과는 위 최신 기록을 따른다.

이전 모델 경로 연결의 검증 결과:

- `test:coverage`: 제품 280개 통과, Postgres 통합 14개 skip, coverage gate 통과.
- `test:eval:coverage`: 평가 78개 통과, coverage gate 통과.
- runtime/eval typecheck, lint, production build, root workspace dead-code 통과.
- 기존 HTTP/provider 경로의 실제 source CLI 합성 completion 96건 통과, 외부 모델·embedding 0회.
- 로컬 HTTP 모의 서버에서 실제 SDK 요청·응답, 429 재시도 0, 잘린 응답 보존·중단 검증.
- 실제 요청 payload의 추가 합성 12건으로 smoke 설정·입력 byte 수를 확인했다.
- 별도 12회 CLI smoke preflight도 통과했다. 전체 합성 artifact 108응답·72쌍의 독립 대조 35개 검사,
  기존 `eval:validate` H30 8개 시나리오, `git diff --check` 통과.
- 웹은 미변경·미재검증. 전체 dead-code는 미설치 웹 의존성 문제를 남기며 root workspace만 통과했다.

이전 examples 입력 준비의 검증 결과:

- 기존 ChatService 프롬프트 준비 96건 통과, chat/embedding 호출 0회.
- examples 54구간의 원문 재조립과 source/기존 분리 입력 hash 불변성, ignore·권한 검증 통과.
- 제품 코드·정식 테스트 변경이 없어 제품/eval 전체 테스트는 이번 입력 조사에서 재실행하지 않았다.

이전 S1 분리 구현의 검증 결과:

- `test:coverage`: 제품 280개 통과, Postgres 통합 14개 skip, coverage gate 통과.
- `test:eval:coverage`: 평가 65개 통과, coverage gate 통과. 분리 회귀 테스트 10개 포함.
- runtime/eval typecheck, lint, production build 통과.
- 전체 dead-code 검사는 미설치 웹 의존성 때문에 실패했다. 변경 범위에는
  `npm run dead-code -- --workspace .`를 실행해 통과했다. 웹 검증은 이번 단계에서 재실행하지 않았다.
- 원문 byte 보존·37개 블록·4개 examples·79개 canon 보존과 실제 source 배치 12건 통과.

이전 P1-1 구현 당시의 전체 검증 결과(웹 결과를 현재 실행 결과로 사용하지 않는다):

- 제품 테스트: 280 통과, Postgres 통합 테스트 14 skip
- 평가 테스트: 55 통과, global statement/line coverage 85.09%
- runtime/eval typecheck: 통과
- Biome lint 139개 파일: 통과
- `knip` dead-code 검사: 통과
- production build: 통과
- web typecheck: 통과
- web 테스트: 37 통과
- web production build: 통과. Turbopack의 로컬 port bind 때문에 샌드박스 밖에서 재실행했다.
- `git diff --check`: 통과
- 새 runtime·fixture에서 운영 캐릭터 이름·ID 검색: 0건

`npm run check`는 runtime/eval 단계까지 통과한 뒤 기존 `origin/main`에도 포함된
`web/backend/characters.ts`의 0% coverage 때문에 web global statement/line coverage가
`88.14%`로 계산되어 기준 `90%`에서 중단된다. 해당 production 파일과 coverage 설정은 이번 diff가
아니다. 무관한 범위를 넓히지 않았고, 동일 웹 테스트를 coverage gate 없이 실행한 결과 37개가 모두
통과했으며 web production build도 별도로 통과했다.

`evals/results/`는 gitignore 대상이다. 구조 HTML·JSON이 없는 checkout에서는
`npm run eval:persona-router`로 다시 생성한다. 현재 workspace의 검수 주소는 서버가 살아 있는 동안
`http://127.0.0.1:18181/persona-router-report.html`이다.

## 핵심 코드 진입점

- `src/persona/persona-router.ts`: prompt channel projection과 provenance
- `src/persona/routed-persona-store.ts`: stable block ID 기반 strict mapping
- `src/chat/chat-service.ts`: first-turn 판정, stable/dynamic 조립, selector seam
- `src/chat/turn-context.ts`: first-contact/retrieved Persona tail section
- `evals/persona-router-eval.ts`: 합성 구조 A/B와 false-PASS 방지
- `evals/persona-source-projection.ts`: 평가 전용 원문 구간 분리와 내용 없는 source map
- `evals/persona-source-projection-cli.ts`: 로컬 입력 투영·구조 probe·격리 artifact 생성
- `evals/persona-comparison.ts`: pinned 입력 검증과 fresh target의 고정 prefix 비교
- `evals/persona-comparison-cli.ts`: 호출 상한·응답/재현 기록·같은 캐릭터 사용자 검수 패킷
- `evals/target.ts`: 고정 Persona/clock/selector와 기존 HTTP/provider 연결
- `evals/evaluate.ts`: 실제 대화 diagnostic/H30 집계
- `evals/review.ts`: 사용자 review artifact와 집계

## 지켜야 할 경계

- 특정 캐릭터를 위한 runtime 예외를 만들지 않는다.
- block title 문자열을 영구 routing 계약으로 사용하지 않는다.
- 모델 temperature 조정을 Persona/Memory 구조 개선의 대체물로 취급하지 않는다.
- 실제 답변을 생성하지 않은 구조 test에 자연스러움 PASS를 붙이지 않는다.
- D29에서 승인된 로컬 DDL만 적용했다. 개발 DB migration/배포/전체 캐릭터 활성화로 확대하지 않는다.
- 실제 Persona 원문, DB 접속 정보, full prompt가 들어간 runtime manifest를 commit하지 않는다.

## Knowledge Delta

- `user-confirmed`: 캐릭터 챗 개선은 특정 캐릭터가 아니라 공통 runtime 경로가 소유한다.
- `user-confirmed`: 자연스러움의 최종 판정은 자동 judge가 아니라 사용자 transcript review다.
- `repo-evidenced`: Persona Router와 strict ID mapping이 stable/dynamic/excluded 경로를 소유한다.
- `repo-evidenced`: P1-0 기준선은 memory lifecycle filtering이 필요함을 보여준다.
- `repo-evidenced`: 개발 DB의 4/45/79 snapshot으로 첫 모델 smoke 12회를 완료했다. 전체 mapping·실제 selector·반복 본 비교는 미검증이다.
- `user-confirmed`: 혼합 8개/22구간만 실험 입력에서 분리하며 examples와 canon을 유지한다.
- `repo-evidenced`: 분리 결과의 주입은 기존 Router가 소유한다. 실험 사용법은 `evals/README.md`에 기록했다.
- `repo-evidenced`: 고정 prefix 비교도 기존 HTTP target/provider와 review가 소유한다. 인증값 없는
  실행·재현 기록과 실패 시 응답 보존, 1인 검수의 한계를 `evals/README.md`에 추가했다.
- `repo/externally-evidenced`: 모델명은 같지만 실제 제공사·reasoning 보고가 달랐다. 결과 보고서와
  계획 정본에 본 비교의 통제 필요성을 반영했으며, 제품 품질 개선으로 승격하지 않았다.
- 계획 재검토: 원인 가설과 관측을 분리하고 실제 selector·캐릭터성·회상·holdout 검증을 추가했다.
  연구 순서는 확정 제품 정책으로 승격하지 않는다. 정본은 연결된 연구 문서의 10~11절이다.
