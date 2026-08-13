# AXtory Phase 9 업무 시스템 구현 감사

감사일: 2026-08-10

대상 범위: GitHub/GitLab PR·CI·Deploy, Jira/Linear Work Item, Local Git 명시 관계

## 완료 판정

Phase 9 구현 범위를 완료했다. 네 Provider를 하나의 evidence pipeline에 연결하되 Vendor별
pagination·인증·상태 계약은 adapter 내부에 유지했다. 내용·사람·URL은 수집 view에서 제외하고,
명시적 commit identity 외 관계를 만들지 않는다.

## 요구사항별 근거

| 요구사항 | 판정 | 근거 |
| --- | --- | --- |
| GitHub PR·Actions·Deploy | 완료 | 공식 REST adapter, deployment latest status, Link pagination |
| GitLab MR·Pipeline·Deploy | 완료 | 공식 REST adapter, page header, 상태 정규화 |
| Jira Work Item | 완료 | enhanced JQL POST, status/time field allowlist, token cursor |
| Linear Work Item | 완료 | GraphQL field allowlist, team filter, Relay cursor, GraphQL error 거부 |
| 안전한 HTTP 경계 | 완료 | HTTPS-only, redirect 거부, timeout, 16 MiB 상한, body-free error |
| Credential 경계 | 완료 | environment-only CLI, literal secret flags 거부, 출력 제외 |
| Pagination/Coverage | 완료 | max 100/page, 반복 cursor·duplicate·bound를 partial 처리 |
| Revision/증분 | 완료 | content-addressed raw view, source updated marker, 재수집 reuse |
| Canonical/Metric | 완료 | WorkArtifact projection, 10개 count metric, Availability/Evidence |
| 미지원 의미 | 완료 | Provider가 제공하지 않는 종류는 `NOT_SUPPORTED`와 null |
| Privacy allowlist | 완료 | title/body/description/comment/log/user/URL/repository 제외 테스트 |
| Local Git 연결 | 완료 | 동일 hashed commit identity만 `OBSERVED` relation |
| 출력 정책 | 완료 | aggregate count와 evidence 상태만 Console/JSON export |

## 검증

- `npm test`: 최종 TypeScript build 포함 66개 자동 테스트 통과
- 네 Provider 공식 문서 응답 shape 기반 adapter contract test 통과
- 공개 GitHub bounded smoke: PR 4, CI 5, Deployment 0, `PARTIAL_PAGINATION`
- 동일 GitHub view 두 번째 수집: 신규 Revision 0, 기존 Revision 9 재사용
- 실제 Local Git snapshot과 explicit commit match 4건, derivation `OBSERVED`
- 실제 저장 Blob scan: title/body/description/login/email/URL/repository name 없음
- `npm audit --omit=optional`: 알려진 취약점 0
- `git diff --check`: whitespace 오류 없음

## 명시적 제한

- GitLab/Jira/Linear 실제 계정 smoke는 credential과 대상 scope가 없어 수행하지 않았다.
- GitHub 공개 무인증 표본은 empty deployment를 포함하며 non-empty deployment 실제 사례는
  합성 contract test로만 검증했다.
- Work Item과 Change Request 간 링크는 안전한 명시 식별자 계약이 없어 만들지 않는다.
- count는 공식 API의 반환 view이며 업무 완료량, 사용자 수용, 배포 효과, AI 기여도가 아니다.
- API rate limit, 권한, retention, 삭제된 Vendor 객체 때문에 완전한 조직 이력을 보증하지 않는다.
