# 업무 시스템 Connector 계약 조사

기준일: 2026-08-10

상태: GitHub 실제 bounded 검증 / 전체 adapter `VERIFIED_BY_TEST`

## 범위와 최소 계약

Phase 9는 업무 내용이나 사람을 복제하지 않고 다음 구조적 사실만 읽는다.

| Provider | 공식 경로 | 수집 종류 | Pagination |
| --- | --- | --- | --- |
| GitHub | REST Pulls, Actions workflow runs, Deployments/statuses | Change Request, CI Run, Deployment | Link header/page |
| GitLab | REST merge requests, pipelines, deployments | Change Request, CI Run, Deployment | `X-Next-Page`/page |
| Jira Cloud | REST v3 enhanced JQL search | Work Item | `nextPageToken` |
| Linear | GraphQL issues connection | Work Item | Relay `pageInfo` cursor |

공식 근거:

- GitHub: [Pull requests](https://docs.github.com/en/rest/pulls/pulls),
  [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
  [deployments](https://docs.github.com/en/rest/deployments/deployments),
  [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- GitLab: [merge requests](https://docs.gitlab.com/api/merge_requests/),
  [pipelines](https://docs.gitlab.com/api/pipelines/),
  [deployments](https://docs.gitlab.com/api/deployments/),
  [REST pagination](https://docs.gitlab.com/api/rest/)
- Jira Cloud: [issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/),
  [REST v3 authentication](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro)
- Linear: [GraphQL API](https://linear.app/developers/graphql),
  [pagination](https://linear.app/developers/pagination),
  [filtering](https://linear.app/developers/filtering)

## 데이터 최소화

Adapter는 가능한 경우 요청 field 자체를 줄이고, 응답에서는 allowlist view만 만든다.
보존 항목은 opaque Vendor ID, canonical/source state, created/updated/completed timestamp,
명시적 commit SHA, 해시된 environment·issue key identity다. 다음은 보존하지 않는다.

- title, body, description, comment, changelog, log
- 사용자 이름, login, email, assignee/author
- URL, repository/project name, branch/ref 이름
- Jira summary/description와 Linear title/description

Opaque ID와 commit SHA는 로컬 Raw Revision에만 존재한다. JSON/Console 집계에는 provider,
coverage, 종류·상태별 count, Availability, evidence count만 나간다. Credential은 환경변수로만
받으며 오류 본문이나 응답 본문은 오류 메시지에 복제하지 않는다.

## 상태와 관계

Vendor 상태는 `OPEN`, `MERGED`, `CLOSED`, `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `CANCELED`,
`COMPLETED`, `BACKLOG`, `UNKNOWN`으로 축소한다. 알 수 없는 상태는 `UNKNOWN`이며 성공으로
간주하지 않는다. Adapter가 제공하지 않는 artifact 종류의 metric은 `NOT_SUPPORTED`다.

PR/MR·CI·Deployment가 명시한 commit SHA는 `OBSERVED` relation evidence다. 그 SHA를 Local
Git snapshot의 commit과 동일한 방식으로 hash해 정확히 일치할 때만 repository relation을
만든다. Work Item↔PR, session↔commit, 작성자, 인과, 실제 배포 효과는 이 계약으로 만들지 않는다.

## 검증 상태와 제한

- GitHub: 공개 `east-true/axtory`에서 무인증 1-page actual collection 완료. PR 4, CI 5,
  Deployment 0의 bounded view가 `PARTIAL_PAGINATION`이었고, 반복 수집은 신규 Revision 0,
  Local Git explicit match 4건이었다.
- GitLab/Jira/Linear: 공식 문서 shape를 고정한 합성 contract test와 민감 필드 배제 테스트 완료.
  실제 계정 credential과 운영 데이터에 대한 smoke는 수행하지 않았다.
- 테스트는 API 전체 필드와 향후 Vendor 변경을 보증하지 않는다. schema 오류는 조용히
  보정하지 않고 collection error로 실패한다.
