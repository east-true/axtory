# AXtory 1차 구현 완료 감사

감사일: 2026-08-09

대상 범위: Foundation부터 Claude Local History 기술 MVP와 Basic Fact Analytics까지

## 완료 범위 정의

1차 구현은 Phase -3~3으로 한정한다. Semantic Analysis, Git correlation, Hook, OTel,
Codex, 업무 시스템, 추가 AI Source, Impact Analysis는 문서화된 후속 Phase이며 완료 조건에
포함하지 않는다.

## 요구사항별 근거

| 요구사항 | 판정 | 근거 |
| --- | --- | --- |
| Local-first, observer, read-only default | 완료 | Core에 원격 호출·Agent 실행·Vendor 설정 변경 경로가 없다. |
| Apache-2.0 및 Vendor 의존성 분리 | 완료 | `LICENSE`, `THIRD_PARTY_NOTICES.md`, SDK 없는 `npm ci` 검증 |
| 제품·설계·단계 문서 | 완료 | `docs/internal`, `docs/design`, `docs/research` |
| Claude 설치·버전·data root·auth Capability | 완료 | discovery 구현, 실제 WSL 설치 및 custom root 검증 |
| 공식 API Session·Message·Tool 수집 | 완료 | 공식 SDK adapter와 bounded 실제 수집 성공 |
| 내부 JSONL parser 금지 | 완료 | Source tree에 Vendor JSONL parser가 없다. |
| Pagination·ordering·Coverage | 완료 | limit/offset, source order, overlap dedup, max-page partial 테스트 |
| Raw/Revision/Normalized/Analysis 분리 | 완료 | SQLite/Blob/Normalizer/Projection/Analyzer 계층과 E2E 테스트 |
| Revision·증분·중복 방지 | 완료 | content hash 및 `lastModified` checkpoint; 재수집 신규 Revision 0 확인 |
| Active Source 변경 | 완료 | post-read metadata 비교와 `PARTIAL_SOURCE_CHANGED` 테스트 |
| Content identity와 Usage occurrence 분리 | 완료 | 동일 Tool input의 서로 다른 occurrence 테스트 |
| 시간 품질 | 완료 | source timestamp 부재 시 `occurredAt=null`, `ORDER_ONLY` 테스트 |
| 기본 Fact Analytics | 완료 | Session, Message, Tool count와 Evidence 기반 CALCULATED Metric |
| 미수집 값 비영점 표현 | 완료 | Assertion `NOT_SUPPORTED`, Token `NOT_COLLECTED`와 reason 테스트 |
| Console·JSON 및 Export audit | 완료 | Sanitized output, atomic JSON, ExportRun |
| Crash recovery·schema migration | 완료 | interrupted-run reconciliation 및 v1→v2 보존 테스트 |
| 민감정보 기본 보호 | 완료 | local 0700/0600, output exclusion, size limit, allowlist, default policy |
| 사용자 Export·삭제 | 완료/부분 | JSON Export와 marker-guarded `PURGE_ALL`; 선택 삭제·Retention은 후속 |
| 합성 Golden Fixture | 완료 | 요구된 9종 시나리오, 실제 개인 Session 미포함 |
| 공개 저장소 기반 | 완료 | README, CONTRIBUTING, SECURITY, Code of Conduct, CI, Dependabot |

## 실제 환경 검증

- WSL Linux x64, Claude Code 2.1.226, Claude Agent SDK 0.3.220
- 공식 API bounded 수집: 5개 세션 후 동일 view 재수집 시 신규 Revision 0개
- 두 번째 bounded 수집: 2개 세션 후 동일 view 재수집 시 신규 Revision 0개
- isolated `CLAUDE_CONFIG_DIR`: 기본 root Session 혼입 없이 0개, returned-view coverage complete
- SDK 제거 후 Core dependency 3개만 설치한 `npm ci` 상태에서 전체 테스트 통과
- `npm audit`: 알려진 취약점 0개
- GitHub Actions: main `421805d` CI completed successfully

실제 Session 내용, ID, 경로, 계정 정보는 공유 보고서나 Git에 포함하지 않았다.

## 명시적으로 남은 제한

- resume 경계는 공식 History view에서 식별할 수 없어 관계를 생성하지 않는다.
- compaction은 Raw system content와 부분 Coverage를 보존하지만 의미 관계를 만들지 않는다.
- worktree와 subagent는 공식 옵션·필드는 확인했으나 cross-version 실제 계약은 부분 지원이다.
- 선택 삭제, 자동 Retention, VerificationRecord UI, UserAnnotation은 후속이다.
- Token·비용은 History에서 추정하지 않으며 Hook/OTel Phase 전까지 `NOT_COLLECTED`다.

이 제한은 구현된 것처럼 숨기지 않고 Capability, Coverage, Availability 또는 후속 Phase로
표현한다.
