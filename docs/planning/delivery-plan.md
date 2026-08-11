# AXtory 단계별 개발 계획

상태: `ACCEPTED` for 순서 / 각 Phase 범위는 구현 전 재검증

기준일: 2026-08-09

## 진행 원칙

각 Phase는 `목표 → 구현 대상 → 새 내부 계약 → 데이터 → 테스트 → 완료 조건 → 경계` 순으로
검토한다. Vendor 동작이 설계와 충돌하면 공식 동작, 충돌점, Core 영향, 최소 변경안,
다른 Connector 영향을 기록한 후 구현한다.

## Phase -3: Foundation

**목표:** 제품 불변조건, Non-goal, 분류, 위협 경계, 라이선스, 의존성, schema 전략 확정.

**현재 결과:** 완료. Apache-2.0, Node.js 24 + TypeScript 단일 언어, 선택적 Vendor SDK,
offline/read-only 기본값을 기록했다.

**완료 조건:** Core 테스트가 Vendor SDK 없이 빌드되고 외부 전송·설정 변경을 하지 않는다.

## Phase -2: Claude Contract Spike

**목표:** 공식 API가 실제 설치에서 반환하는 계약을 민감정보 없이 검증한다.

**구현 대상:** discovery, version/auth capability, SDK adapter, structural report.

**테스트:** normal, resumed, tool-heavy, compacted, active, missing-fields, custom-config-dir,
corrupted-source, unsupported-version, worktree, subagent.

**현재 결과:** 기본 설치·세션 열거·긴 세션·Tool type과 격리 custom-root SDK는 실제 검증.
active-session 변경 감지는 합성 테스트로 검증했다. resume, compaction, worktree, subagent는
여전히 `NEEDS_SPIKE` 또는 `NOT_SUPPORTED`다.

**완료 조건:** 각 항목이 `VERIFIED`, `NOT_SUPPORTED`, `PARTIAL_CAPABILITY` 중 하나로 근거와
함께 종결되고 합성 Golden Fixture가 생성된다.

## Phase -1: Core Data Model

**목표:** Walking Skeleton에 필요한 최소 모델만 확정한다.

**현재 구현:** ExecutionEnvironment, SourceProfile, CapabilityAssessment, CollectionRun,
SourceObject/Revision, RawObservation, NormalizedObservation, SessionProjection, AnalysisRun,
AnalysisRecord, MetricDefinition, ExportRun의 최소 부분.

**남은 범위:** CollectionPolicy 영속 모델과 Evidence/Verification의 최소 schema를 실제
Claude Backfill 요구에 맞춰 추가한다. AnalysisUnit 완전 구현은 보류한다.

## Phase 0: Walking Skeleton

**목표:** 합성 Fixture 하나가 전체 흐름을 실제 통과한다.

**현재 결과:** `normal-session`이 Blob → Revision → Normalization → Projection → Fact
Analyzer → Console/JSON을 통과한다. 반복 수집, schema migration, interrupted run을 테스트했다.

**경계:** Fixture 성공은 Claude History Backfill 성공을 의미하지 않는다.

## Phase 1: Claude Discovery

**목표:** 같은 실행 환경의 Claude 설치와 읽기 Capability를 안정적으로 설명한다.

**구현 대상:** executable/version, `CLAUDE_CONFIG_DIR`, data root, auth availability, SDK
availability 및 호환성 결과.

**테스트:** Windows/WSL/Linux/macOS path 규칙, 권한 거부, malformed output, timeout,
custom root. 실제 계정 식별자는 테스트·로그·보고서에 남기지 않는다.

**완료 조건:** 지원/미지원/부분 지원이 reason과 evidence를 가지며 설정을 변경하지 않는다.

## Phase 2: Claude Local History

**목표:** 공식 API 반환 Session·Message·Tool block을 Revision 기반으로 증분 수집한다.

**구현 순서:**

1. SDK DTO를 격리하는 Claude 내부 adapter
2. Session 목록 snapshot과 pagination/coverage
3. Session별 content hash 및 immutable Revision
4. Message·Tool block raw blob reference
5. deterministic normalizer
6. incremental checkpoint와 overlap-safe dedup
7. corruption·active update·중단 복구

**테스트:** Contract Fixture 전 종류, 동일 hash 재수집, 변경 Revision, pagination overlap,
partial retention, active session 변경, crash before/after DB commit.

**완료 조건:** 실제 합성 Fixture 전체와 통제된 로컬 세션이 중복 없이 수집되고 내부 JSONL
parser가 존재하지 않는다.

**현재 결과:** 공식 SDK pagination, Session/Message/Tool raw view, content-hash Revision,
deterministic normalization, `lastModified` 기반 message 재조회 생략, active-source change
감지, SessionProjection, Fact Analytics, Console/JSON 출력을 구현했다. 제한된 실제 설치
smoke test에서 첫 수집 후 동일 view의 신규 Revision 0개를 확인했다. resume/compaction/
worktree/subagent의 의미 관계는 생성하지 않는다.

## Phase 3: Basic Fact Analytics

**목표:** LLM 없이 직접 관찰·계산 가능한 사실만 제공한다.

**지표:** Session·Message·사용일·허용된 cwd 분포·Tool occurrence·Agent assertion.

**완료 조건:** 모든 지표가 Metric Catalog 정의, Availability, Provenance, Evidence,
입력 Revision을 가지며 Assertion을 검증 사실로 출력하지 않는다.

**현재 결과:** Session, Message, Tool invocation count를 Evidence 기반 `CALCULATED` Metric으로
구현했다. Rule Analyzer가 free-form Agent assertion을 분류하지 못하는 상태는
`NOT_SUPPORTED`, History 채널에서 Token을 수집하지 않는 상태는 `NOT_COLLECTED`와 이유로
출력한다. 두 경우 모두 0으로 표시하지 않는다.

## Phase 4~7

- **Phase 4 Semantic Analysis:** Rule/Local/Remote Analyzer. 모든 의미 분석은 `INFERRED`.
- **Phase 5 Local Git:** 별도 Artifact Source. 초기 연결은 `CORRELATED` 또는 `INFERRED`.
- **Phase 6 Claude Hook [OPT]:** 동의 기반 lifecycle 수집, bounded Spool, 설정 rollback.
- **Phase 7 Claude OTel [OPT]:** Token/model/cost/latency. 비용 종류와 namespace 분리.

**현재 결과:** 2차 구현으로 완료했다. 선행조건으로 VerificationRecord, UserAnnotation,
CollectionPolicy 영속화, 선택 삭제 세 모드와 자동 Retention을 먼저 구현했다. Rule Analyzer는
명시적 content 분석 동의가 있을 때만 실행하며 결과를 `INFERRED` assertion으로 저장한다.
Local/Remote 모델은 Tool 권한을 갖지 않는 strict structured-result adapter 계약까지 제공하고
Provider 자체는 `NOT_CONFIGURED`다.

Local Git은 별도 SourceObject/Revision으로 수집하며 경로, diff, commit message, 작성자 신원을
보존하지 않는다. 사용자가 Session Revision을 명시했을 때 시간 창이 겹친 commit만
`INFERRED`의 `CORRELATED` 관계로 저장하고 작성·인과를 주장하지 않는다.

Hook/OTel은 기본 OFF다. opt-in 설정 시 loopback·Bearer 인증 Receiver, 크기·rate·용량 제한,
중단 복구 가능한 Spool, 기존 설정 병합, exact backup/rollback을 사용한다. OTel `http/json`
metrics/logs에서 content/identity를 정규화 결과에 복제하지 않고 token/model/추정 cost/latency를
분리한다. gRPC/protobuf, trace beta, content-bearing OTel gate는 지원하지 않는다.

**검증:** 합성 Hook/OTLP payload, 실제 임시 Git repository, 설정 merge/backup/rollback,
Spool 중단 복구·idempotency, Blob/WAL/Spool 삭제 범위를 자동 테스트한다. 실제 Claude live
세션 발화는 이후 `claude --settings <격리 파일>`로 검증했다. 사용자 전역 설정은 읽지도 쓰지도
않았고 digest가 전후 동일했으며, 생성한 설정은 `rollback-live`로 원본과 byte 단위로 복원했다.
실제 Hook 3건과 OTLP 3건이 도착했고 token·model·추정 cost·latency Fact를 event·metric channel
별로 얻었다. 실제 payload가 담은 `tool_input`, `tool_response`, `last_assistant_message`, cwd,
transcript path는 Canonical 관찰에 남지 않았다.

## Phase 8: Codex

**목표:** 두 번째 Connector로 Claude 전용 추상화를 검증한다.

**선행 Spike:** App Server lifecycle, `thread/list`, `thread/read`, pagination, sourceKind,
parent/ancestor, `useStateDbOnly`, metadata repair 여부, active thread 읽기.

**완료 조건:** Claude와 Codex 구현에서 실제 공통성이 확인된 최소 계약만 Public Connector
SPI 후보 문서로 제안한다. 공통되지 않은 항목은 Connector 내부에 남긴다.

**현재 결과:** 완료했다. `codex app-server` 0.147.0의 안정 `thread/list`와 `thread/read`만
사용하며 experimental turn pagination은 사용하지 않는다. 원본 `CODEX_HOME`에서 App Server를
직접 시작하면 SQLite runtime 초기화 쓰기가 발생함을 확인했으므로, 원본 state DB의 일관된
읽기 전용 backup으로 임시 private home을 만든 뒤 실행한다. 목록은 active/archive와 현재의
모든 source kind를 명시하고 `useStateDbOnly: true`를 강제한다.

반환 thread는 Raw/Revision/Normalized/SessionProjection/Fact/Output 경로를 통과한다. active,
list/detail 수정시각 불일치, compaction, non-full turn, pagination bound를 완전한 이력으로
표시하지 않는다. fork/parent는 공식 응답의 명시 필드가 있을 때만 관계를 만든다.

**후속:** 격리 읽기에서는 `status`와 `updatedAt`이 liveness를 알릴 수 없음을 실제 사례로
확인하고, 끝나지 않은 turn을 `completedAt === null`로 판정하는 `PARTIAL_UNSETTLED_TURN`을
추가했다. thread의 `cwd`와 `gitInfo.branch`도 Claude와 같은 해싱 규칙으로 digest만 수집해
`--workspace-dir`가 두 Source를 함께 선택하도록 했다. Normalizer는 `codex-app-server/2`다.

Claude/Codex 공통 최소 계약은 `architecture/connector-spi-candidate.md`에 후보로 기록했지만,
공개 SPI는 아직 만들지 않았다. offset/cursor, SDK/stdio lifecycle, active consistency,
sourceKind와 lineage는 Connector 내부에 남겼다.

## Phase 9: 업무 시스템

**목표:** 공식 업무 시스템 API에서 PR/MR, CI, Deployment, Work Item의 content-free 사실을
증분 수집하고, 명시적 commit identity만 Local Git과 연결한다.

**현재 결과:** 완료했다. GitHub/GitLab은 Change Request·CI Run·Deployment를, Jira/Linear는
Work Item을 제공한다. HTTPS-only 요청, 응답 크기·timeout·redirect 제한, cursor/page pagination,
중복·상한의 partial coverage, immutable Revision, deterministic normalization, Fact metric,
Console/JSON 출력을 구현했다. 지원하지 않는 종류는 `NOT_SUPPORTED`로 남긴다.

Vendor title, description/body, comment, log, 사용자 신원, URL, 저장소명은 요청 또는 source
view allowlist에서 제외한다. CLI는 credential literal을 거부하고 환경변수에서만 읽는다.
업무 시스템이 명시한 commit SHA와 Local Git의 hashed commit identity가 같을 때만
`OBSERVED` 관계를 만든다. Work Item↔PR, session↔commit, 작성·인과·완료·AI 기여 관계는
추론하지 않는다.

**검증:** 공식 문서 기반 응답 shape의 GitHub/GitLab/Jira/Linear 합성 contract test,
pagination/HTTP/normalization/incremental/privacy test, 공개 GitHub 실제 bounded collection과
Local Git 재수집 연결을 통과했다. 인증이 필요한 GitLab/Jira/Linear 실제 계정 smoke는
수행하지 않았으며 Vendor 운영환경 전체를 검증했다는 의미가 아니다.

## Phase 10: 추가 AI Source

**목표:** Gemini CLI, OpenCode, Cursor Agent, Aider의 공식 비파괴 읽기 경로를 동일한
Revision/Evidence pipeline에 연결하되 Provider별 capability 차이를 보존한다.

**현재 결과:** 완료했다. OpenCode의 공식 JSON list/export는 Message·Tool occurrence까지
정규화한다. Gemini CLI는 문서화된 Session list만 읽어 metadata-only로
표시하고 preview를 폐기한다. Aider는 사용자가 명시한 chat-history Markdown을 Raw local
evidence로 보관하지만 안정된 Message schema를 추측하지 않는다.

네 Source 모두 Discovery/Capability, immutable Revision, incremental reuse, SessionProjection,
Fact, Console/JSON 경로를 통과한다. limit, 목록/상세 사이 원천 변경, metadata-only, 비정형
원문은 각각 explicit coverage와 Availability로 표현한다. Raw conversation, path, Session ID,
model, identity, tool payload는 출력하지 않는다.

**검증:** 공식 문서/소스 shape 기반 합성 contract test와 Aider의 실제 AXtory child-process
CLI 수집을 통과했다. 이후 Gemini CLI 0.54.4, OpenCode 1.18.16, Aider 0.86.2를 실제 설치해
검증했다. 세 Vendor 모두 discovery가 실행 파일과 버전을 읽고 capability를 산출하며, AXtory가
호출하는 명령·플래그(`--list-sessions`, `session list --format json --max-count`, `export`)가
현재 버전에 존재한다. Aider가 실제로 생성한 `.aider.chat.history.md`를 수집해 Session 1건과
`UNKNOWN` coverage, `NOT_SUPPORTED` Message/Tool fact를 확인했고 재수집 시 신규 Revision은
0건이며 홈 경로·프로젝트 경로·파일명이 정규화 결과와 JSON에 남지 않았다. 자격증명이 없는
Gemini는 exit 41로 실패해 AXtory가 명시적 오류로 종결하며 세션 0건으로 위장하지 않는다.
Cursor Agent 2026.08.04-aaa8809도 설치해 확인한 결과 비파괴 Session 목록 명령이 없었다.
`cursor-agent ls`는 이름과 달리 대화형 resume picker다. Discovery는 설치 여부와 무관하게
`session_enumeration`을 `NOT_SUPPORTED`로 보고하고 adapter는 CLI를 실행하지 않는다.
Kimi Code 0.34.0은 문서화된 저장소를 직접 읽는 Connector로 구현해 Message·Tool과 Rule Semantic
경로까지 연결했다.

## Phase 10.5: Usage Analytics

**목표:** 수집·정규화된 내부 Evidence를 사용자가 직접 읽을 수 있는 로컬 Usage Report로
통합한다. 수집 반복으로 쌓인 Revision을 중복 합산하지 않고 SourceObject별 최신 Revision만
사용한다.

**현재 결과:** 완료했다. `report-usage`는 전체 또는 반복 `--source` 범위에서 Session·Message·
Tool occurrence, 사용자/Assistant 메시지, Session당 분포, 활성 UTC 일수, Tool 사용 Session
비율, 메시지·Tool 비율, Source별 집계, UTC 일별 timeline을 제공한다. Tool 이름은 안전한
범주로 축소하고 custom MCP/dynamic 이름을 출력하지 않는다.

`--since`/`--until`은 원천 `occurredAt`의 반개구간이며, 시각이 없는 관찰은 bounded report에서
제외한 수와 이유를 남긴다. partial/compacted/unknown view는 `PARTIAL`로 유지한다. 의미 분석은
기본 `NOT_COLLECTED`이며 `--allow-conversation-content`를 명시한 경우에만 현재 보존 Revision의
Rule Semantic Analyzer를 실행해 검증되지 않은 `INFERRED` 범주로 통합한다.
schema v5 이전 Source처럼 완료 Collection head relation이 없으면 migration 시 고정한 Revision을
legacy fallback으로 포함하되 `PARTIAL`과 개수를 출력한다.

Raw Evidence가 삭제된 최신 Revision은 count를 유지하더라도 `EVIDENCE_REMOVED`와 `PARTIAL`을
표시한다. 같은 DB에 opt-in Claude OTel이 있으면 token/model/추정 cost/latency를 event·metric
channel별로 분리하고 누락 범주는 `NOT_COLLECTED`로 유지한다. 선택 Evidence에 연결된
VerificationRecord와 UserAnnotation은 내용 없이 집계한다. 반복 `--source`는 한 DB 안의
filter이며 서로 다른 data directory를 연합하지 않는다.

**검증:** 최신 Revision 선택, 기간 내 미상 시각 제외, Source unavailable null, Tool privacy,
분포·timeline·semantic opt-in, Raw 삭제 전후 Evidence, OTel channel 분리, 연결 Verification·
Annotation privacy, 실제 child-process CLI를 합성 테스트로 검증했다. 비어 있지 않은 로컬
Codex data directory에서도 리포트를 생성하고 Raw content/path가 JSON에 없음을 확인했다.

**후속:** 같은 범위 안에서 다섯 가지를 추가했다. Semantic 상한 초과 시 각 창이 상한을 넘지
않는 `--since`/`--until` 조합을 계산해 제시한다. `list-annotations`는 `annotate`와
`verify --note`가 저장한 사용자 작성 텍스트를 stdout으로만 되읽으며 파일이나 ExportRun을 남기지
않는다. schema v6·v8이 Annotation과 Verification Note에 DataClassification을 부여해 Retention
경로에 연결했고, Annotation은 레코드를 삭제하지만 Note는 텍스트만 지워 Verification 상태를
남긴다. `compare-usage`는 두 기간을 각각 측정해 나란히 출력하되 양쪽이 모두 측정한 값에만 차이를
제시하고 인과를 주장하지 않는다. schema v7 `--baseline-minutes`는 사용자가 선언한 기준선을
숫자로 저장하며, Export 정책이 허용하는 분류만 합산하고 나머지는 `REDACTED`로 보류한다.
AXtory는 뺄셈할 실제 소요 시간을 기록하지 않으므로 이 합계를 절약된 시간으로 제시하지 않는다.
schema v9는 Retention이 지운 Verification Note 수를 `deletion_runs`에 남겨 삭제 감사가 실제
수행분과 일치하게 했다.

여섯 번째로 `--workspace-dir`가 Session이 실행된 디렉터리로 리포트 범위를 좁힌다. Claude와
Codex 모두 절대 경로와 branch 이름의 digest만 기록하고 리포트도 호출자가 지정한 경로를 같은
방식으로 해싱해 digest끼리만 비교하므로, 경로와 branch 이름은 리포트에 들어가지 않는다. 아무도
작업하지 않은 디렉터리는 0이 아니라 `SOURCE_UNAVAILABLE`이다. branch는 작업공간과 별도 분모로
센다. Git 작업 트리 밖에서 실행된 Codex thread는 branch가 없는데 이는 수집 누락이 아니기
때문이다. 재수집은 이 필드를 채우지 못하므로 기존 디렉터리는 `renormalize`로 채운다. 배경은
`architecture/system-design.md`에 기록했다.

**정합성 보강:** Connector·Live·Report 경로 감사로 확인한 결함을 함께 수정했다. 원천 시각은
UTC로 정규화한 뒤에만 저장하고, live envelope 하나의 실패가 같은 실행에서 적재된 Revision을
가리지 않으며, 식별자 없는 Message는 partial coverage로 보존한다. Vendor 고유 id가 없으면
다른 식별자 namespace로 대체하지 않고 실패한다. 응답 크기 상한은 버퍼링 전 streaming 중
적용하고, evidence 목록이 SQLite host parameter 상한을 넘어도 batch로 나눠 동작한다.
Receiver는 rate limit 이전에 인증해 미인증 트래픽이 예산을 소모하지 못하게 한다.

## Phase 11

- **Phase 11 Impact Analysis:** 충분한 사용자별 baseline 이후 ESTIMATED 효과 분석

## 바로 다음 작업

1. **완료:** `missing-fields`, `tool-heavy`, `corrupted-source`, `unsupported-version` 합성 Fixture
2. **완료:** pagination·ordering Contract Test
3. **완료:** custom `CLAUDE_CONFIG_DIR` 격리 child-process Spike
4. **완료:** active 변경 감지와 resume·fork·compaction·worktree·subagent 통제 계약. 전체 로컬 이력 구조 읽기와 통제된 resume·fork·worktree Session으로 확인했다. resume은 같은 `sessionId`를 연장하고, fork만 Vendor `uuid` 공유로 관측되며, worktree는 계보가 아닌 작업공간 맥락이다
5. **완료:** 공식 Claude Local History를 Revision/Normalization/Analysis/Output 경로에 연결
6. **완료:** Phase 4~7과 선행 신뢰·삭제 계약
7. **완료:** Phase 8 Codex App Server Connector와 Public SPI 후보 감사
8. **완료:** Phase 9 업무 시스템 Connector와 explicit commit identity 기반 Local Git 연결
9. **완료:** Phase 10 Gemini CLI/OpenCode/Cursor/Aider capability별 Source 수집
10. **완료:** Phase 10.5 최신 Revision 기반 Usage Analytics Console/JSON 리포트
11. **완료:** 아래 네 가지. 자격증명이 필요한 content 검증만 환경 제약으로 남았다

- **완료 — Claude `FORKED_FROM`:** `analyze-fork-lineage`가 분석 단계에서 `INFERRED` 관계를
  만든다. 판정식은 두 Session의 0번부터 연속된 공통 시작부와 생성 시각 순서를 모두 요구하며,
  공통 시작부 밖에서 identity를 공유하면 추측 대신 관계를 만들지 않는다. 내용에서 파생된
  identity를 가진 Session은 제외해 같은 첫 프롬프트가 fork로 둔갑하지 않게 했다. 실제 86 Session
  수집에서 후보 1쌍·관계 1건·애매 0건으로 프로브 결과를 재현했다.
- **완료 — 재정규화:** `renormalize`가 파생 관측치를 제자리에서 재계산하며 Revision을 새로 만들지
  않는다. Revision은 raw content hash로 원천의 한 상태를 뜻하고 Normalizer 변경은 원천 변경이
  아니기 때문이다. Raw는 다시 쓰지 않고, Coverage는 그때의 읽기를 서술하므로 이어받으며, 해당
  Revision을 쓴 AnalysisRecord는 `INVALIDATED`가 된다. 실제 75 Revision Codex 디렉터리에서
  `codex-app-server/1` 전량을 `/2`로 올려 리포트가 `PARTIAL, 3 distinct, 58 sessions without one`
  에서 `AVAILABLE, 6 distinct`로 바뀌는 것을 확인했다.
- **완료 — Claude 실제 active Session:** 실제 라이브 Session으로 확인했고 negative 결론이다.
  진행 중인 turn을 읽으면 Message 1건, 끝난 뒤 3건이며 끝나지 않았다는 표식이 되는 필드가 없다.
  이 모양은 이력의 다수를 차지하는 버려진 첫 메시지와 동일해 view 안에서 구분할 수 없고, Codex의
  `completedAt` 판정에 해당하는 Claude 필드가 없다. `lastModified`는 실행 중 실제로 올라가지만
  전체 수집 9회와 더 좁은 주기 67회 모두 발화하지 않았다. 실행 중 Session이 목록 index 0에 앉아
  창이 가장 짧고 bounded 실행이 약 2회만 기록하기 때문이다. 진행 중 view가 완전하다고 기록될 수
  있다는 Vendor 한계를 문서화했다.
- **완료 — Codex 추가 버전 호환성:** 0.146.1을 임시 prefix에 설치해 사용자의 전역 0.147.0을
  건드리지 않고 비교했다. method·`sourceKinds` 어휘·응답 shape는 같지만, AXtory가 항상 보내는
  `thread/read(includeTurns: true)`를 0.146.1이 paginated thread에 대해 거절한다(실제 40건 중
  5건). 따라서 **0.147.0이 하한**이다. 이 과정에서 client가 서버 error message를 버리고 코드만
  남기던 결함을 고쳤다. 0.147.0 초과 버전은 미검증이다.
- **부분 완료 — Gemini/OpenCode/Kimi content 검증:** **OpenCode는 실제 대화로 완전히 검증했다.**
  `opencode run`이 인증 없이 동작해 Session을 직접 만들고 변경하며 확인했다. Vendor store와
  수집 결과가 일치하고, role·`partTypes`가 OpenCode 고유 구조를 보존하며, 상한은 `PARTIAL_LIMIT`,
  `--project-dir`가 실제로 범위를 좁히고, Tool 이름은 `other` 범주로만 남으며, Codex와의 합산·
  필터가 정확하고, 삭제 후 `EVIDENCE_REMOVED`를 표시하며, Rule Semantic과 Usage Report를
  통과하고, 제목·id·경로·projectId 유출은 0건이다. 기존 Session에 turn을 덧붙이면 변경된 것만
  새 Revision이 되고(신규 1·불변 2) 리포트는 최신 Revision만 세어 재수집을 사용량으로 오인하지
  않는다. Fork는 declared field도 공유 message id도 없어 관측 불가능하므로 관계를 만들지 않는
  현재 동작이 옳다. Gemini(auth 미설정)와 Kimi(대화형 `/login` 요구)만 남았고 계정 연결은 사용자
  결정이라 하지 않았다. 근거는 `research/additional-ai-contracts.md`에 있다.

Codex `gitInfo.originUrl` 수집은 하지 않기로 결정했다.

자동 AnalysisUnit, ROI/Impact Analysis, Dashboard는 다음 범위다. Usage Report는 Dashboard
없이도 현재 로컬 데이터를 직접 읽을 수 있는 CLI 계층으로 완료했다.
