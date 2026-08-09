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

## Phase 4~7

- **Phase 4 Semantic Analysis:** Rule/Local/Remote Analyzer. 모든 의미 분석은 `INFERRED`.
- **Phase 5 Local Git:** 별도 Artifact Source. 초기 연결은 `CORRELATED` 또는 `INFERRED`.
- **Phase 6 Claude Hook [OPT]:** 동의 기반 lifecycle 수집, bounded Spool, 설정 rollback.
- **Phase 7 Claude OTel [OPT]:** Token/model/cost/latency. 비용 종류와 namespace 분리.

이 Phase들은 Phase 2·3의 신뢰 모델과 삭제 정책이 검증되기 전 시작하지 않는다.

## Phase 8: Codex

**목표:** 두 번째 Connector로 Claude 전용 추상화를 검증한다.

**선행 Spike:** App Server lifecycle, `thread/list`, `thread/read`, pagination, sourceKind,
parent/ancestor, `useStateDbOnly`, metadata repair 여부, active thread 읽기.

**완료 조건:** Claude와 Codex 구현에서 실제 공통성이 확인된 최소 계약만 Public Connector
SPI 후보 문서로 제안한다. 공통되지 않은 항목은 Connector 내부에 남긴다.

## Phase 9~11

- **Phase 9 업무 시스템:** GitHub/GitLab/CI/Jira/Linear/PR/Deploy
- **Phase 10 추가 AI Source:** Gemini CLI, OpenCode, Cursor, Aider 등
- **Phase 11 Impact Analysis:** 충분한 사용자별 baseline 이후 ESTIMATED 효과 분석

## 바로 다음 작업

1. **완료:** `missing-fields`, `tool-heavy`, `corrupted-source`, `unsupported-version` 합성 Fixture
2. **완료:** pagination·ordering Contract Test
3. **완료:** custom `CLAUDE_CONFIG_DIR` 격리 child-process Spike
4. **부분 완료:** active 변경 감지; resume/compaction/worktree/subagent 통제 절차는 후속
5. **완료:** 공식 Claude Local History를 Revision/Normalization/Analysis/Output 경로에 연결

자동 AnalysisUnit, ROI, Dashboard, Hook, OTel은 이 순서에 끼워 넣지 않는다.
