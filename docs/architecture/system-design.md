# AXtory 시스템 설계

상태: `ACCEPTED` for Foundation / `PROPOSED` for 미구현 영역

기준일: 2026-08-10

## 1. 설계 목표

- 인터넷과 중앙 서비스 없이 기본 수집·저장·분석·출력이 동작한다.
- Vendor 설정과 세션 데이터는 기본적으로 읽기만 한다.
- Vendor 원문, Canonical 관찰값, 분석 결과가 서로 오염되지 않는다.
- 불완전한 데이터와 불확실성을 손실 없이 표현한다.
- 반복 수집, 중단, 원천 변경, 재분석을 이력으로 보존한다.
- 민감한 수집 데이터와 분석 모델 출력을 모두 신뢰하지 않는다.
- Claude에만 맞춘 추상화를 Public Core 계약으로 고정하지 않는다.

## 2. 시스템 경계

```text
┌──────────────── Existing user workflow ────────────────┐
│ Claude Code       Codex       Future AI/work systems   │
└───────────────┬─────────────────────────────────────────┘
                │ official read API / opt-in event channel
┌───────────────▼──────── AXtory ─────────────────────────┐
│ Discovery → Capability → Collection → Raw/Revision      │
│                    → Normalization → Projection         │
│                    → Analysis → Output Policy → Sink    │
└───────────────┬─────────────────────────────────────────┘
                │ local files only by default
        SQLite / Blob Store / Spool
```

AXtory는 Agent 실행, 모델 선택, Prompt 중계, Vendor 로그인 대행을 하지 않는다.

## 3. 런타임 형태

### 3.1 Snapshot CLI

초기 기본 형태다. 사용자가 실행할 때 Source를 탐색하고 증분 수집한 뒤 종료한다.
SQLite에는 CollectionRun을 Source 접근 전에 기록한다.

### 3.2 Optional Local Receiver

2차 구현에서 opt-in으로 추가했다. Claude HTTP Hook과 OTLP HTTP exporter가 URL endpoint를
요구하므로 IPv4 loopback과 실행 시 생성한 Bearer token을 사용한다. 외부 interface에는
bind하지 않는다. Receiver는 body 크기·rate·content type을 검증하고 분석 없이 bounded
Spool에 기록한다. UDS/Named Pipe는 현재 Vendor HTTP 설정이 직접 지원하지 않아 사용하지 않는다.

### 3.3 Local Dashboard

후속 기능이다. 구현할 경우 기본 bind는 loopback이며 외부 인터페이스 공개를 기본값으로
두지 않는다.

## 4. 모듈 경계

```text
core/
  model, revision, availability, policy, storage
connectors/claude/
  discovery, capability, official history adapter, normalizer
connectors/git/
  read-only local snapshot, normalizer, collector
connectors/codex/
  discovery, isolated App Server adapter, pagination, normalizer, collector
connectors/work-systems/
  HTTPS boundary, GitHub/GitLab/Jira/Linear adapters, pagination, normalizer, collector
connectors/additional-ai/
  Gemini CLI/OpenCode/Cursor/Aider adapters, discovery, normalizer, collector
projections/
  session/work-artifact projection, future analysis-unit projection
analysis/
  metric catalog, fact analyzer, usage report, semantic analyzer, Git/work correlation, OTel facts
outputs/
  console, JSON, output policy, export audit
live/
  opt-in Hook/OTLP receiver, bounded spool, ingestion, settings backup/rollback
fixtures/
  synthetic Vendor contract data
```

이 경계는 내부 모듈 구성이며 Public Connector SPI가 아니다. Claude/Codex 구현으로 확인한
공통점은 별도 후보 문서에만 두며 Connector 함수나 Vendor DTO를 외부 안정성 계약으로
게시하지 않는다.

## 5. 데이터 파이프라인

```text
Fixture 또는 Vendor Source
→ Discovery / CapabilityAssessment
→ CollectionRun STARTED
→ RawObservation + content-addressed Blob
→ SourceObject / immutable SourceRevision
→ deterministic NormalizedObservation
→ SessionProjection
→ versioned Fact Analyzer
→ AnalysisRun / AnalysisRecord / Evidence
→ OutputPolicy
→ ConsoleSink / JsonFileSink
→ ExportRun
→ CollectionRun COMPLETED
```

프로세스가 중단되어 terminal 상태가 없으면 다음 실행이 해당 CollectionRun 또는
AnalysisRun을 `FAILED / INTERRUPTED`로 조정한다. stdout이 조용하다는 이유만으로 실패나
완료를 판단하지 않는다.

Live 경로는 `HTTP → Spool STARTED/RECEIVED → PROCESSING → Raw/Revision/Normalized →
Analysis → COMPLETED`를 사용한다. PROCESSING에서 중단되면 다음 ingest가 FAILED/INTERRUPTED로
조정한 뒤 재시도한다.

## 6. 핵심 데이터 모델

### 실행 및 Source

- `ExecutionEnvironment`: Windows, WSL, Linux, macOS, Docker 등 독립 실행 환경
- `SourceProfile`: Source 종류, 환경, data root, executable, active version
- `CapabilityAssessment`: 기능별 Availability, 이유, 근거, 검사 시각
- `CollectionRun`: 수집 시도와 terminal 상태

같은 PC의 Windows Claude와 WSL Claude는 서로 다른 Source 환경이다. 초기 탐색 범위는
Collector와 같은 환경으로 제한한다.

### 원천과 Revision

- `SourceObject`: Vendor가 식별하는 논리 객체
- `SourceRevision`: content hash가 다른 불변 Revision
- `RawObservation`: 원천 payload reference와 Provenance

동일 SourceObject와 동일 hash는 새 Revision을 만들지 않는다. 내용이 변하면 새 Revision을
추가하며 기존 Revision을 덮어쓰지 않는다. 완료된 CollectionRun이 실제로 관찰한 Revision을
별도 relation으로 기록하므로 예전 content hash가 다시 나타나도 가장 최근 생성 Revision으로
오인하지 않는다. 실패한 CollectionRun의 relation은 current head 선택에서 제외한다.

### Canonical 관찰

`NormalizedObservation`은 `EVENT`, `SNAPSHOT`, `CONTENT`, `METRIC`, `RELATION`을 표현한다.
Normalization은 Vendor 구조를 Canonical 형태로 옮기지만 `INTENT`, `REQUIREMENT`,
`GOAL_COMPLETION` 같은 의미 분석을 만들지 않는다.

### 대화 및 실행 개념

`SourceConversation`, `SessionRun`, `Turn`, `AgentExecution`, `Message`, `ToolInvocation`,
`AnalysisUnit`을 동일시하지 않는다. 특히 Session 종료는 업무 완료가 아니다.

Lineage 관계 후보는 `RESUMED_FROM`, `FORKED_FROM`, `SUBAGENT_OF`, `COMPACTED_FROM`,
`CONTINUED_FROM`, `UNKNOWN`이다. 실제 Vendor 근거가 없는 관계는 생성하지 않는다.

### 분석

- `SessionProjection`: 한 Revision의 세션·메시지·도구 Evidence를 읽기 모델로 구성
- `MetricDefinition`: key, 의미, 단위, 공식 버전, 집계, 필요 Source, 한계
- `AnalysisRun`: Analyzer·버전·입력 Revision·파라미터·비용 이력
- `AnalysisRecord`: 값, Derivation, Availability, Evidence
- `UserAnnotation`: 원본 분석을 덮어쓰지 않는 사용자 주장

`UsageReportAnalyzer`는 SourceObject마다 가장 최근에 수집된 Revision 하나만 선택해 Session
Evidence를 합산한다. 전체 이력 Revision을 모두 더해 재수집을 사용량으로 오인하지 않는다.
기간 범위는 `occurredAt`의 `[since, until)`이며 collector 시각으로 누락 시각을 대체하지 않는다.
Session 분포, Source별 count, UTC 일별 timeline과 안전한 Tool 범주는 `CALCULATED`다.

Rule Semantic 결과는 별도 `INFERRED` AnalysisRun이며 Conversation content 동의가 있을 때만
생성한다. Usage Report는 현재 Revision과 연결된 완료 Semantic run만 집계한다. 이 리포트의
비율은 사용 패턴이지 성과·품질·자율성·AI 기여·Impact가 아니다.

Usage Report는 선택 Revision의 Raw 보존 상태를 별도 Evidence 축으로 표시한다. Raw 삭제 뒤
Normalized count를 계속 제공할 수는 있지만 `EVIDENCE_REMOVED`와 `PARTIAL`을 숨기지 않는다.
같은 DB의 Claude OTel token/model/추정 cost/latency Fact는 event와 metric channel을 분리한 채
표시하며 미수집 범주를 0으로 만들지 않는다. 선택 Evidence에 연결된 VerificationRecord와
UserAnnotation은 원문을 복제하지 않는 집계로 표시하고 원 분석과 독립된 축을 유지한다.

리포트의 저장 경계는 하나의 AXtory data directory와 SQLite DB다. 반복 `--source`는 같은 DB에
수집된 Source를 고르는 filter이며 여러 DB를 연합하거나 병합하는 기능이 아니다.

## 7. 신뢰 모델

### 7.1 Derivation과 명제 종류

Derivation은 `OBSERVED`, `CALCULATED`, `INFERRED`, `ESTIMATED`다. 명제 종류
`SOURCE_CONTENT`, `ASSERTION`, `FINDING`, `METRIC`, `RELATION`과 별도 축이다.

### 7.2 Provenance

`OFFICIAL_API`, `DOCUMENTED_STORAGE`, `LOCAL_FILE`, `EXTERNAL_API`, `USER_PROVIDED`,
`HEURISTIC`을 기록한다. `OBSERVED`도 Provenance와 Source integrity에 따라 잘못될 수 있다.

### 7.3 Verification

하나의 결과에 여러 `VerificationRecord`가 붙는다. 검증 유형은 `SOURCE_INTEGRITY`,
`TECHNICAL`, `HUMAN_ACCEPTANCE`, `WORKFLOW`, `DEPLOYMENT`, `PRODUCTION_OUTCOME`이며 상태는
`VERIFIED`, `PARTIAL`, `FAILED`, `REJECTED`, `CONTRADICTED`, `UNKNOWN`, `NOT_APPLICABLE`이다.

기술 검증 성공과 사용자 수용은 서로 대체하지 않는다.

## 8. 시간 모델

- `occurredAt`: Source가 보고한 발생 시각
- `observedAt`: Collector가 읽은 시각
- `sourceModifiedAt`: Source 객체 수정 시각
- `receivedAt`: live event 도착 시각

품질은 `EXACT`, `SOURCE_REPORTED`, `RECEIVER_TIMESTAMP`,
`FILE_MODIFIED_APPROXIMATION`, `ORDER_ONLY`, `UNKNOWN`으로 기록한다. `occurredAt`을 모르면
Collector 읽기 시간을 대신 넣지 않는다.

## 9. Content identity와 Usage occurrence

동일 Content가 resume·fork·subagent에서 재사용될 수 있다. 콘텐츠 분석은 hash identity로
중복 제거할 수 있지만 실제 Context 사용이나 Tool 호출 발생은 각각의 occurrence로 남긴다.
현재 합성 Fixture는 동일 Tool input identity 두 건을 서로 다른 usage occurrence로 검증한다.

## 10. 저장 설계

### SQLite

Metadata, SourceObject, Revision, Raw reference, NormalizedObservation, AnalysisRun,
AnalysisRecord, Policy, ExportRun, index를 저장한다.

- WAL, foreign key, busy timeout 사용
- 짧은 `BEGIN IMMEDIATE` 쓰기 transaction
- `PRAGMA user_version` 기반 forward migration
- schema v5의 completed CollectionRun↔observed Revision relation과 migration-time legacy head
- DB 및 데이터 디렉터리는 기본적으로 사용자 전용 권한
- Snapshot MVP는 single writer

### Blob Store

Prompt, 응답, Tool output, diff 등 큰 원문은 SHA-256 content-addressed 파일로 한 번 저장한다.
SQLite 행에 대형 원문을 반복하지 않는다. Blob hash dedup은 Usage occurrence 집계에 적용하지 않는다.

### Spool

Hook·OTel 수신 시에만 사용한다. Envelope state history에는 기존 상태를 바꾸지 않고
started/progress/terminal 항목만 추가하며 매번 원자적으로 교체한다. item/byte 상한을 모두
적용하고 DB 적재 후 idempotency key와 immutable Revision으로 중복을 제거한 뒤 terminal
Envelope를 제거한다. DB가 장기 Evidence 소유자가 된다.

## 11. Connector 설계

### Claude Code

접근 우선순위는 공식 Session SDK, Hook, OTel, 문서화 저장 형식 순서다. 내부 JSONL 직접
파싱은 초기 Core 경로에 넣지 않는다. SDK가 없거나 호환되지 않으면 명시적 Capability
상태를 반환하며 조용한 fallback을 하지 않는다.

Claude TypeScript SDK는 별도 설치하는 선택 의존성이다. Core dependency와 배포물에 Vendor
binary를 포함하지 않는다.

### Codex

공식 App Server의 안정 `thread/list`, `thread/read(includeTurns: true)`만 사용한다. 시작 시
runtime SQLite 쓰기가 필요하므로 원본 Codex state DB는 read-only SQLite backup으로 임시
private `CODEX_HOME`에 복제하고 App Server의 모든 쓰기는 그 snapshot에 격리한다. 목록에는
`useStateDbOnly: true`와 active/archive 및 현재 source kind 전체를 명시해 rollout metadata
repair scan을 요청하지 않는다. experimental turn pagination과 내부 JSONL parser는 사용하지
않는다.

stdio adapter는 `initialize`, `thread/list`, `thread/read` 외 client request를 만들 수 없고
server-initiated request를 거부한다. cursor와 offset, active consistency, sourceKind, lineage는
Vendor 내부 계약이며 Claude DTO에 맞추지 않는다.

### 업무 시스템

GitHub/GitLab의 PR·MR, CI run/pipeline, deployment와 Jira/Linear work item을 공통
`WorkArtifact` 내부 형태로 정규화한다. 이 형식은 Public SPI가 아니며 각 Vendor의 page/cursor,
인증, 상태 enum은 adapter 안에 남긴다. 모든 요청은 HTTPS만 허용하고 redirect, timeout,
16 MiB 응답 상한을 적용한다.

Raw view도 Vendor 전체 응답이 아니라 ID·상태·source timestamp·명시적 commit link와 해시된
environment/key 식별자만 남기는 allowlist다. title, body/description, comment, log, user identity,
URL, repository name은 저장하지 않는다. commit identity는 Local Git과 동일하게 SHA-256한 뒤
일치하는 경우에만 `OBSERVED` relation으로 결합한다.

### 추가 AI Source

Gemini CLI, OpenCode, Cursor Agent, Aider는 공통 `AdditionalAiSourceApi` 내부 경계를 사용하지만
동일한 데이터 능력을 가정하지 않는다. Gemini/Cursor는 목록 ID를 해시한 metadata-only
Revision을 만든다. OpenCode는 공식 pure JSON list/export를 사용해 Message content identity와
명시적 Tool part occurrence를 정규화한다. Aider는 사용자가 명시한 Markdown history를 Raw로
보존하되 Message 경계를 추론하지 않는다.

CLI child process는 shell 없이 실행하고 timeout/output size/cwd를 제한한다. list preview,
path, Vendor ID, content는 Console/JSON에 내보내지 않는다. limit와 원천 변경은 partial,
구조화 export가 없으면 `NOT_COLLECTED` 또는 `NOT_SUPPORTED`다. 이 내부 API 역시 Public SPI가
아니다.

## 12. CollectionPolicy와 데이터 분류

분류는 `PUBLIC_METADATA`, `LOCAL_METADATA`, `IDENTIFYING_METADATA`,
`CONVERSATION_CONTENT`, `SOURCE_CONTENT`, `TOOL_CONTENT`, `SECRET`, `PERSONAL_DATA`다.

정책은 분류별 `capture`, `persist`, `analyze`, `export`, `retention`을 제어한다. 알 수 없는
분류는 fail closed한다. 현재 Walking Skeleton은 합성 Fixture 전용이며 일반 사용자 원문에
대한 완전한 정책 엔진이 구현됐다고 간주하지 않는다.

## 13. 분석 보안

```text
Untrusted content
→ quarantine
→ redaction / size limit
→ tool-less analyzer
→ structured JSON
→ strict schema validation
→ evidence existence validation
→ AnalysisRecord
```

향후 의미 분석 모델에는 Shell, filesystem, MCP, network, Connector 설정, credentials,
OutputSink 권한을 주지 않는다. unknown field, enum, 길이, Evidence ID를 모두 검증한다.

## 14. Sink 보안

- Console: ANSI/control 제거, 길이 제한
- JSON: schema 제한, 원자적 쓰기, 사용자 전용 권한
- HTML: escape, raw HTML 금지, CSP
- CSV: formula injection 방어
- Markdown: raw HTML 비활성화, 외부 image 자동 로드 제한
- Webhook/DB: schema, parameterized query, 크기 제한, idempotency

OutputPolicy가 허용하지 않은 분류와 Derivation은 Sink가 임의로 우회할 수 없다. 외부 전송은
destination, policy version, record count, classification, status, digest를 ExportRun에 기록한다.

## 15. 삭제와 Retention

정책 후보는 `DELETE_RAW_ONLY`, `DELETE_RAW_AND_DERIVED`, `DELETE_SOURCE_SESSION`,
`PURGE_ALL`이다. Raw Evidence 삭제 시 의존 분석을 `EVIDENCE_REMOVED` 또는 `INVALIDATED`로
표시하거나 정책에 따라 함께 제거한다.

marker와 명시적 `PURGE_ALL` 확인문을 요구하는 전체 데이터 디렉터리 삭제는 구현했다.
`DELETE_RAW_ONLY`, `DELETE_RAW_AND_DERIVED`, `DELETE_SOURCE_SESSION`과 분류별 자동
Retention도 구현했다. 선택 삭제는 Blob reference count, 분석 Evidence 상태 변경 또는
파생 run 제거, SQLite `secure_delete`와 WAL checkpoint, 같은 Session의 pending Spool까지
Contract Test로 검증한다.

## 16. 확장과 배포

- Core 실행에는 AXtory 계정, 중앙 서버, 원격 AI API가 필요하지 않다.
- Built-in Connector만 실행한다.
- Community Connector는 후속 별도 프로세스 격리 후보이며 자동 탐색·실행하지 않는다.
- Microservice와 Message Broker는 도입하지 않는다.
- 단일 언어 Node.js + TypeScript를 유지한다.

## 17. 현재 구현과 설계의 경계

### 구현·테스트됨

- Claude discovery와 공식 API structural spike
- Availability 모델
- Raw/Revision/Normalized/Projection/Analysis 분리의 Walking Skeleton
- content-addressed Blob, SQLite WAL 및 v1→v2 migration
- content identity와 usage occurrence 분리
- Console/JSON 출력, ExportRun
- 반복 수집 중복 방지와 interrupted run reconciliation
- `lastModified` 기반 증분 message read 생략과 active-source change 감지
- 기본 CollectionPolicy 및 marker-guarded `PURGE_ALL`
- VerificationRecord, UserAnnotation, CollectionPolicy 영속화
- 선택 삭제, Retention, Blob/WAL/Spool 범위 처리
- opt-in Rule Semantic Analyzer와 strict Local/Remote structured-result adapter
- 별도 Local Git Source와 temporal correlation
- loopback Hook/OTLP `http/json` Receiver, bounded Spool, 설정 backup/rollback
- content-free OTel token/model/추정 cost/latency 정규화·분석
- 격리 snapshot 기반 Codex App Server thread 수집과 Fact/Semantic 경로
- 실제 App Server state에서 확인한 Codex subagent lineage와 spawn/fork 구분
- 통제된 실제 Claude Hook/OTel live session 수신·정규화 검증
- Claude/Codex 공통 최소 Connector 계약 후보 문서
- GitHub/GitLab/Jira/Linear 업무 시스템 Connector와 explicit Git relation
- Gemini CLI/OpenCode/Cursor/Aider capability별 Source Connector
- 문서화된 저장소를 직접 읽는 Kimi Code Connector와 Rule Semantic 경로
- 최신 Revision·기간·Source·Session·Tool·Evidence·Telemetry·Verification 범주의 Usage
  Analytics Console/JSON 리포트
- Claude Session과 Codex thread의 작업공간 맥락을 digest로 수집하는 `--workspace-dir` 범위 지정
- Vendor 메시지 정체성으로 Claude fork를 찾아 `FORKED_FROM`을 `INFERRED`로 내는 분석 pass
- Raw를 다시 읽어 파생 관측치만 제자리 재계산하는 `renormalize`

### 미구현 또는 추가 Spike 필요

- 실제 Provider가 연결된 Local/Remote Semantic Analyzer와 AnalysisUnit
- OTLP gRPC/protobuf 및 beta trace 수신
- App Server daemon이 live state를 읽을 때 `active`를 보고하는지 (수집기는 의도적으로 snapshot을
  읽으므로 결과와 무관하다)
- Codex 0.147.0 초과 버전 호환성 (0.146.1은 하한 미만으로 확인)
- Muse Code Connector: 읽기 경로는 확인했으나 export 필드명이 미공개
- 자격증명이 있는 실제 세션에서의 Gemini/OpenCode/Kimi content 검증 (세 Source 모두 자격증명
  부재로 막혀 있으며 discovery와 실패 처리는 실제 설치본으로 검증했다)
- Public Connector SPI 안정화·게시 결정

Cursor Agent는 미구현이 아니라 Vendor가 비파괴 목록 경로를 제공하지 않는 경우다. Discovery가
`NOT_SUPPORTED`로 보고한다.

재수집은 Normalizer 변경을 반영하지 못한다. 재사용 판단이 `(source_object_id,
source_modified_at)`만 보고 normalizer 버전을 보지 않으며, 설령 재사용을 막아도 Revision id가
content hash에서 결정되고 관측치 삽입이 `ON CONFLICT(source_revision_id, stable_key) DO NOTHING`
이라 새 정규화 결과가 조용히 버려진다. 실제로 `codex-app-server/1`로 수집한 75 Revision
디렉터리에 재수집하면 새로 생긴 24건만 `workspaceIdentity`를 갖고 재사용된 26건은 그대로였다.

**결정:** 재정규화는 파생 관측치를 제자리에서 다시 계산하며 Revision을 새로 만들지 않는다.
SourceRevision은 raw view의 content hash로 식별되므로 원천의 한 상태를 뜻한다. Normalizer가
바뀌었다고 원천이 바뀐 것은 아니고, Revision을 새로 만들면 바뀌었다고 주장하는 셈이며 모델이
기대는 유일성과도 충돌한다. Raw 불변성은 원본을 수정하지 않는다는 뜻이고 파생 계층 재계산을
금지하지 않는다.

`renormalize`가 이를 수행한다. Revision의 저장된 normalizer 버전이 현재와 다르면 raw를 다시 읽어
정규화하고 관측치를 교체한 뒤 버전을 기록한다. Head Revision뿐 아니라 저장된 모든 Revision을
대상으로 하는데, 밀려난 Revision도 보존된 증거이고 그것만 옛 Normalizer로 남기면 같은 DB가 어느
Revision을 읽느냐에 따라 같은 질문에 다르게 답하기 때문이다. Coverage는 다시 계산하지 않고
저장된 값을 이어받는다. Coverage는 내용이 아니라 그때의 읽기를 서술하므로, 지금 다시 만들면
이미 끝난 읽기에 대한 판단을 지어내는 것이 된다. 그 Revision을 입력으로 삼은 AnalysisRecord는
`INVALIDATED`가 된다. 증거가 사라진 것이 아니라 다시 계산되었으므로 `EVIDENCE_REMOVED`가
아니다. Raw가 이미 삭제된 Revision은 옛 정규화가 그 Revision에 남은 전부이므로 그대로 둔다.

Claude와 Codex는 raw view가 Normalizer 입력을 온전히 담아 재정규화할 수 있다. 추가 AI Source는
raw에 Vendor payload만 있고 Normalizer가 읽는 파싱된 view가 없어 live adapter 없이는 입력을
복원할 수 없으므로, 조용히 건너뛰지 않고 이유와 함께 미지원으로 보고한다.

Claude는 진행 중인 turn을 표시하지 않는다. 실행 중인 Session을 읽으면 user Message 1건만
돌아오고, turn이 끝난 뒤 같은 Session은 3건(user·assistant·assistant)을 돌려준다. 어떤 Message도
평소의 key 외에 아무것도 갖지 않으므로 turn이 끝나지 않았다는 표식이 없다. 게다가 이 모양은
전체 이력 265 Session 중 152건을 차지하는 "버려진 첫 메시지"와 동일하다. 즉 실행 중인 turn과
버려진 Session은 같은 view이며 view 안에서 구분할 방법이 없다. Codex는 turn의 `completedAt`으로
snapshot 안에서 판정하지만 Claude에는 대응 필드가 없어 `PARTIAL_UNSETTLED_TURN`에 해당하는
Claude 판정식이 존재하지 않는다.

`lastModified` 비교는 죽은 신호는 아니다. 실행 중에 값이 실제로 올라간다(약 1분에 서로 다른 값
3개). 다만 실제로는 발화하지 않았다. 라이브 Session 대상 전체 수집 9회와 더 좁은
목록·읽기·재읽기 67회 모두 `sourceChangedViews: 0`이었다. 이유는 두 가지를 측정해 확인했다.
`listSessions`가 최근 수정순으로 반환해 실행 중인 Session이 94건 목록에서 항상 index 0에
앉으므로 목록 snapshot과 자기 재읽기 사이 간격이 가장 짧고, bounded 실행은 연속이 아니라 약 2회만
기록한다. 따라서 쓰기가 밀리초 창 안에 들어와야 한다.

결과적으로 AXtory는 진행 중인 Claude Session을 `COMPLETE_FOR_RETURNED_VIEW`로 기록할 수 있고
이를 막을 신호가 없다. 모든 Claude Session을 `UNKNOWN`으로 두면 드문 오류를 상시 무용함과
바꾸는 것이고, 최근성 임계값을 만드는 것은 coverage 어휘가 피하려는 바로 그 추측이다. Vendor
한계로 기록하며, 이후 수집이 완전한 Revision으로 대체한다.

Claude의 resume·compaction·subagent는 미구현이 아니라 Vendor 근거가 없는 경우다. 전체 로컬
이력 265 Session·24917 Message를 구조만 읽고, 별도로 통제된 resume·fork Session을 만들어
확인했다. Resume은 같은 `sessionId`를 유지하며 이어 붙으므로 맺을 관계 자체가 없다.
`parent_agent_id`·`parent_tool_use_id`는 모든 메시지에서 null이고 43회의 `Agent` 호출도 별도
Session을 만들지 않는다. 메시지 `type`은 user·assistant·system뿐이라 compaction 경계 표식이
없다.

Worktree는 계보가 아니라 작업공간 맥락이다. 통제된 worktree Session은 그 worktree의 `cwd`와
`gitBranch`를 그대로 갖고 반환되지만 본 작업 트리의 Session과 이어주는 키가 없다.
`includeWorktrees`는 true·false·미지정에서 모두 같은 결과였다. 게다가 265 Session 이력에서
같은 `cwd`가 여러 branch를 갖는다(12개 디렉터리에 31개 `(cwd, gitBranch)` 조합). 즉 branch
전환과 worktree가 같은 모양으로 나타나므로 저장소 정체성 없이는 구분할 수 없다.

Codex는 이 점에서 다르다. Thread view의 `gitInfo`가 `originUrl`을 노출하므로 저장소 정체성을
읽을 수 있다. 수집하지 않기로 한 이유는 아래 결정에 적었다. 두 Connector는 `cwd`와 branch의
digest만 읽는다.

Fork는 다르다. `--fork-session`은 새 `sessionId`를 만들고 어떤 필드로도 부모를 선언하지 않지만,
부모의 메시지를 Vendor가 부여한 `uuid`째로 복제하며 `session_id`만 자식으로 고쳐 쓴다. 따라서
Fork는 내용 유사성이 아니라 Vendor 메시지 정체성으로 관측 가능하다.

실제 이력 85 Session·14744 Message를 정체성만으로 읽어 이 신호가 Fork를 실제로 분리하는지
측정했다. uuid 14576개가 단일 Session에만 나타났고, 공유된 168개가 만든 Session 쌍은 가능한
3570쌍 중 **한 쌍뿐**이었다. 그 쌍은 짧은 쪽 168개가 긴 쪽 618개의 **0번부터 연속된 prefix**였고
`cwd`와 `gitBranch`도 같았으며, prefix를 가진 쪽이 약 22시간 먼저 만들어졌다. prefix가 아닌
부분 겹침은 0쌍이었다. 즉 오탐이 없고 방향도 두 신호가 일치한다.

**결정:** `FORKED_FROM`을 생성하되 Codex와 같은 방식으로는 하지 않는다. `analyze-fork-lineage`로
구현했다.

- Derivation은 `OBSERVED`가 아니라 `INFERRED`다. Codex는 선언된 `forkedFromId`를 읽으므로 Vendor의
  주장이지만, Claude는 아무것도 선언하지 않고 구현 세부가 남긴 흔적에서 추론한다. 둘을 같은 종류의
  사실로 제시하면 Claude 쪽을 과장하는 것이고, Derivation 어휘는 정확히 이 차이를 위해 있다.
- Normalizer가 아니라 분석 단계에 둔다. 비교 대상이 Session 간이고 Normalizer는 한 번에 한 Session만
  보기 때문이다.
- 판정식은 겹침이 아니라 정확한 prefix 포함이다. 0번부터 연속이어야 하고 prefix를 가진 쪽이 더
  오래되어야 한다. 애매한 경우는 추측 대신 관계 없음이 된다.
- Vendor가 fork 시 uuid를 재발급하면 신호가 사라져 관계가 생성되지 않는다. 이는 coverage 어휘로
  표현 가능한 미탐이며, 복구 불가능한 오탐보다 낫다.
- 구현하면서 content fallback 경로를 막았다. Normalizer는 `uuid`가 없으면 메시지 index와 내용의
  hash로 identity를 만드는데, 그러면 같은 첫 프롬프트로 시작한 두 Session이 identity를 공유해
  전체 이력 읽기가 경고했던 바로 그 조작된 계보가 된다. 이제 `sourceMessageIdentityFrom`을
  기록하고, 내용에서 파생된 identity를 하나라도 가진 Session은 비교 대상에서 제외한다. 이 필드가
  생기기 전 Revision은 표식이 없으며 Vendor 부여로 간주하는데, 측정한 14744 Message가 예외 없이
  `uuid`를 가졌기 때문이다. Normalizer는 `claude-official-history/3`이다.

실제 86 Session 수집에 돌려 프로브와 정확히 같은 결과를 얻었다. 후보 1쌍, 관계 1건, 애매한 쌍
0건, 방향 불명 0건이며 168 Message 부모와 약 22시간 뒤 만들어진 618 Message 자식이 168개의
공통 시작부를 공유한다.

Codex `gitInfo.originUrl`은 같은 부류로 보였지만 결론이 다르다. **수집하지 않는다.** worktree와
branch 전환을 구분해 준다는 이점이 있으나, Claude에 대응 필드가 없어 Source 간 비대칭이 생기고,
로컬 경로와 달리 원격 저장소를 가리키는 식별자라 해싱해도 보존 근거가 약하다. 무엇보다 이 구분을
요구하는 제품 요구가 아직 없다.
