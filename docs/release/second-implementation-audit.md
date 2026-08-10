# AXtory 2차 구현 완료 감사

감사일: 2026-08-09

대상 범위: Phase 4~7과 그 선행조건인 신뢰 기록·선택 삭제·Retention

## 완료 범위 정의

1차 구현 완료선인 Phase -3~3 다음 묶음을 2차 구현으로 정의한다. Phase 4 Semantic
Analysis, Phase 5 Local Git, opt-in Phase 6 Claude Hook, opt-in Phase 7 Claude OTel이 대상이다.
이 Phase들의 시작 조건이었던 Verification/UserAnnotation과 삭제 정책 검증도 포함한다.
Codex Connector와 Public SPI, AnalysisUnit, ROI, Dashboard, 업무 시스템은 포함하지 않는다.

## 요구사항별 근거

| 요구사항 | 판정 | 근거 |
| --- | --- | --- |
| schema v3 forward migration | 완료 | v2 분석 record 보존, trust/policy/deletion table 추가 테스트 |
| VerificationRecord 다중 검증 | 완료 | 분석 record FK, 유형·상태·Provenance·Evidence·시각 영속화 |
| UserAnnotation 비파괴 기록 | 완료 | Source Revision/Analysis Record 존재 검증 후 별도 table 저장 |
| CollectionPolicy 영속화 | 완료 | 수집 및 Retention 실행 시 versioned canonical policy 저장 |
| 선택 삭제 세 모드 | 완료 | Raw-only, Raw+Derived, Source Session별 Contract Test |
| Evidence/Blob/WAL/Spool 삭제 범위 | 완료 | Evidence 상태, reference 없는 Blob, secure_delete/checkpoint, pending Session event 테스트 |
| 분류별 Retention | 완료 | DB Raw와 Hook/OTel Spool cutoff 동시 적용, 정책 보존 테스트 |
| Rule Semantic Analyzer | 완료 | 명시적 content 동의, 좁은 deterministic rule, `INFERRED` assertion, 원문 비복제 |
| Local/Remote 분석 경계 | 완료/미설정 | tool-less runner 계약과 exact schema/Evidence 검증 구현; Provider는 번들·자동 설정하지 않음 |
| Local Git Artifact Source | 완료 | read-only 명령, metadata 최소 snapshot, Revision idempotency를 임시 실제 repo에서 검증 |
| Git-Session 관계 | 완료 | 사용자 지정 Session의 시간 창만 `INFERRED/CORRELATED`; 작성·인과 부정문 포함 |
| Hook Receiver | 완료/부분 검증 | HTTP Hook, loopback, Bearer, 크기/rate 제한, bounded Spool; 실제 Claude 발화는 미실행 |
| Claude 설정 변경 안전성 | 완료 | 명시 확인문, 기존 key 병합, 0600 exact backup, idempotent merge, rollback 테스트 |
| OTel Receiver | 완료/부분 검증 | OTLP `http/json` metrics/logs 합성 payload 검증; gRPC/protobuf/trace는 미지원 |
| OTel privacy gate | 완료 | prompt/tool detail/tool content/raw API body OFF, account/session metric ID OFF 설정 |
| Live 중단 복구·멱등성 | 완료 | PROCESSING→FAILED reconciliation, request-id/Revision dedup, terminal Spool cleanup 테스트 |
| Token/model/cost/latency | 완료 | content-free `OBSERVED` Fact, 추정 cost 별도 namespace/reason, 미수집은 `NOT_COLLECTED` |
| 민감정보 출력 제외 | 완료 | Hook tool input/path와 OTel email/prompt가 Normalized/JSON에 없는 합성 테스트 |
| 사용자 CLI | 완료 | list, analyze-rule, collect-git, plan/serve/ingest/rollback-live, delete, retain, annotate, verify |

## 자동 검증

- `npm test`: TypeScript build 포함 43개 테스트 통과
- `npm audit --omit=optional`: 알려진 취약점 0개
- 실제 임시 Git repository에서 동일 snapshot 재수집 시 새 Revision 0개
- loopback HTTP Receiver에 인증/비인증 Hook·OTLP 요청 검증
- live settings merge → exact backup → rollback byte equality 검증
- spool interrupted state reconciliation과 ingestion 후 replay dedup 검증
- schema v1→v3 보존 smoke와 v2→v3 analysis record 보존 검증

## 명시적 제한

- Rule match와 Local/Remote model finding은 실제 기술 검증이 아니라 `INFERRED`다.
- Local/Remote model Provider는 포함하지 않으며 연결 전까지 `NOT_CONFIGURED`다.
- Git 시간 상관은 commit 작성 주체나 Session의 인과를 증명하지 않는다.
- Hook/OTel은 자동 활성화하지 않는다. 사용자가 Receiver를 실행하고 exact confirmation을
  제공해야 설정을 변경하며, 종료 후 원하면 출력된 backup으로 rollback해야 한다.
- OTel 비용은 Vendor 추정치이며 청구 자료와 분리한다.
- OTLP gRPC/protobuf와 beta trace는 지원하지 않는다.
- 실제 Claude live Hook/OTel emission은 개인 설정을 자동 변경하지 않기 위해 이번 감사에서
  실행하지 않았다. 구현 계약은 공식 문서와 합성 HTTP/OTLP 테스트로 검증했다.
- Codex는 Phase 8이며 2차 완료 범위가 아니다. Public Connector SPI도 아직 공개하지 않는다.
