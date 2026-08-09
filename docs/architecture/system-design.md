# AXtory 시스템 설계

상태: `ACCEPTED` for Foundation / `PROPOSED` for 미구현 영역

기준일: 2026-08-09

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

Hook·OTel Phase에서만 추가한다. Unix Domain Socket 또는 Windows Named Pipe를 우선하고,
불가능하면 Loopback과 임의 인증 토큰을 사용한다. Receiver는 body 크기·rate·schema를
검증하고 분석 없이 bounded Spool에 기록한다.

### 3.3 Local Dashboard

후속 기능이다. 구현할 경우 기본 bind는 loopback이며 외부 인터페이스 공개를 기본값으로
두지 않는다.

## 4. 모듈 경계

```text
core/
  model, revision, availability, policy, storage
connectors/claude/
  discovery, capability, official history adapter, normalizer
connectors/codex/                 # Phase 8 이후
projections/
  session projection, future analysis-unit projection
analysis/
  metric catalog, fact analyzer, future semantic analyzers
outputs/
  console, JSON, output policy, export audit
receivers/                       # opt-in Hook/OTel 이후
fixtures/
  synthetic Vendor contract data
```

이 경계는 내부 모듈 구성이며 Public Connector SPI가 아니다. 두 번째 Connector 구현 전에는
Connector 함수나 Vendor DTO를 외부 안정성 계약으로 게시하지 않는다.

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
추가하며 기존 Revision을 덮어쓰지 않는다.

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
- DB 및 데이터 디렉터리는 기본적으로 사용자 전용 권한
- Snapshot MVP는 single writer

### Blob Store

Prompt, 응답, Tool output, diff 등 큰 원문은 SHA-256 content-addressed 파일로 한 번 저장한다.
SQLite 행에 대형 원문을 반복하지 않는다. Blob hash dedup은 Usage occurrence 집계에 적용하지 않는다.

### Spool

Hook·OTel 수신 시에만 사용한다. append-only envelope에 started/progress/terminal 상태를
남기며 DB 적재 후 idempotency key로 중복을 제거한다.

## 11. Connector 설계

### Claude Code

접근 우선순위는 공식 Session SDK, Hook, OTel, 문서화 저장 형식 순서다. 내부 JSONL 직접
파싱은 초기 Core 경로에 넣지 않는다. SDK가 없거나 호환되지 않으면 명시적 Capability
상태를 반환하며 조용한 fallback을 하지 않는다.

Claude TypeScript SDK는 별도 설치하는 선택 의존성이다. Core dependency와 배포물에 Vendor
binary를 포함하지 않는다.

### Codex

Phase 8에서 공식 App Server JSON-RPC를 Contract Spike한다. `thread/list`의 metadata repair
가능성과 `useStateDbOnly`의 coverage 차이를 먼저 검증한다. Claude DTO에 맞춘 Core SPI를
Codex 구현에 강제하지 않는다.

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
`DELETE_RAW_ONLY`, `DELETE_RAW_AND_DERIVED`, `DELETE_SOURCE_SESSION`과 자동 Retention은
아직 구현되지 않았다. 선택 삭제는 Blob reference count, 분석 무효화, WAL·Spool 범위까지
Contract Test를 갖춘 후 지원 상태로 변경한다.

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

### 미구현 또는 추가 Spike 필요

- resume, fork, compaction, real active session, worktree, subagent controlled contract
- 선택 삭제, Retention, UserAnnotation, VerificationRecord
- Hook/OTel Receiver와 설정 rollback
- Semantic Analyzer, Git correlation, AnalysisUnit
- Codex Connector와 Public SPI 결정
