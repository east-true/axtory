# AXtory 문서

이 디렉터리는 AXtory의 기획·설계·검증 근거를 관리한다. 구현보다 앞서는 규칙은
`제품 기획`과 `시스템 설계`에 기록하고, Vendor 사실은 `Connector 조사`에서 분리한다.

## 문서 지도

| 문서 | 역할 | 상태 |
| --- | --- | --- |
| [제품 기획](planning/product-plan.md) | 문제, 사용자 가치, 범위, 제품 원칙, 성공 기준 | 기준 문서 |
| [단계별 개발 계획](planning/delivery-plan.md) | Phase별 목표, 구현 대상, 테스트, 완료 조건 | 진행 중 |
| [시스템 설계](architecture/system-design.md) | 런타임, 계층, 데이터·신뢰·보안·저장 구조 | 기준 문서 |
| [Foundation 결정](architecture/foundation.md) | 초기 불변조건과 기술 선택의 간결한 기록 | 승인됨 |
| [Connector Contract 조사](research/connector-contracts.md) | Claude/Codex 공식 사실, 로컬 관찰, Gap | 진행 중 |
| [1차 구현 완료 감사](release/initial-implementation-audit.md) | 기술 MVP 요구사항별 구현·검증 근거 | 완료 |
| [2차 구현 완료 감사](release/second-implementation-audit.md) | Phase 4~7 및 선행 신뢰·삭제 계약의 구현·검증 근거 | 완료 |
| [Phase 8 구현 감사](release/phase8-codex-audit.md) | Codex Connector, 실제 App Server Spike, SPI 후보 결정 | 완료 |
| [Connector SPI 후보](architecture/connector-spi-candidate.md) | Claude/Codex 공통 최소 계약과 비공통 경계 | 후보 |
| [기존 구현 계획](implementation-plan.md) | 최초 Repository 분석과 구현 현황 기록 | 보존 문서 |

## 상태 용어

- `ACCEPTED`: 현재 설계 결정이며 변경 시 근거와 영향 분석이 필요하다.
- `VERIFIED`: 공식 문서 또는 통제된 실제 실행으로 확인했다.
- `VERIFIED_BY_TEST`: AXtory의 합성 테스트로 동작을 검증했다. Vendor 동작 검증은 아니다.
- `PROPOSED`: 구현 전 후보이며 공개 계약이 아니다.
- `NEEDS_SPIKE`: 실제 인터페이스 검증 전에는 확정하지 않는다.
- `DEFERRED`: 현재 Phase 범위 밖이다.

문서와 코드가 충돌하면 이를 조용히 합리화하지 않는다. 실제 동작을 확인하고 충돌,
Core 원칙 영향, 최소 변경안, 다른 Connector 영향을 기록한 뒤 문서를 갱신한다.
