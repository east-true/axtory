# AXtory

[English](README.md) | [한국어](README.ko.md)

AXtory는 AI 지원 업무를 관찰하는 local-first 도구입니다. Claude Code나 Codex 같은 도구가
제공하는 근거를 수집하지만 Agent 실행기나 Prompt Proxy 역할은 하지 않습니다.

제품 기획, 아키텍처, 개발 단계, Connector 근거는 [`docs/README.md`](docs/README.md)에
정리되어 있습니다. 한국어 기획·설계 문서가 현재 프로젝트의 기준이며, 구현 상태와 제안된
동작은 구분해서 기록합니다.

이 저장소에는 개인정보를 배제한 Claude·Codex 계약 Spike, Fixture 기반 Core Walking
Skeleton, 공식 API History Collector, opt-in 의미·실시간 분석, 최소 metadata만 수집하는
Local Git Artifact Collector, GitHub/GitLab/Jira/Linear 업무 시스템 Connector가 있습니다.
로컬 Usage Report는 최신 보존 Revision을 기간·Source·Session·개인정보를 배제한 Tool 패턴으로
집계합니다. Raw data는 로컬 불변 Revision에 보관하며, 정제된 Projection과 근거 기반 분석은
분리합니다.

## 현재 보장 사항

- 기본값은 읽기 전용이며 Vendor 설정을 변경하지 않습니다.
- 원격 Telemetry, 오류 보고, Prompt 또는 Code 업로드가 없습니다.
- 누락된 값은 임의의 0이 아니라 Availability와 이유로 표시합니다.
- Vendor data, Canonical observation, Analytics를 서로 다른 계층으로 유지합니다.
- Claude 또는 Codex SDK가 없어도 Core를 빌드하고 테스트할 수 있습니다.
- Claude 또는 Codex 내부 JSONL Parser를 사용하지 않습니다.
- 의미 분석 결과와 Git 상관관계를 검증된 사실로 표시하지 않습니다.
- Hook·OTel 수집은 명시적인 설정 동의가 필요하고 loopback에만 bind하며, 정확한 설정
  backup으로 복구할 수 있습니다.
- 업무 시스템 Token은 지정한 환경변수로만 받습니다. 저장 view에서 title, description,
  comment, log, 사용자 신원, URL, 저장소명을 제외합니다.
- 추가 AI Source는 Provider별 coverage를 그대로 표시합니다. Session 목록이나 비정형 log에서
  Message·Tool fact를 임의로 만들어내지 않습니다.

## 개발

Node.js 24 이상이 필요합니다.

```sh
npm install
npm test
```

합성 end-to-end 경로를 두 번 실행하면 content hash 기반 멱등성을 확인할 수 있습니다.

```sh
npm run skeleton
npm run skeleton
```

선택적인 Claude Spike에는 사용자가 설치한 Claude Code 실행 파일과 별도로 설치한 공식 Agent
SDK가 필요합니다. AXtory는 둘 다 번들하지 않습니다.

```sh
npm install --no-save --omit=optional @anthropic-ai/claude-agent-sdk@0.3.220
npm run spike:claude -- --output local-spike-results/claude.json
```

Spike report에는 구조 metadata만 들어갑니다. 자세한 내용은
[`docs/research/connector-contracts.md`](docs/research/connector-contracts.md)를 참고하세요.

## Codex History

Codex 수집은 사용자가 설치한 `codex` 실행 파일과 공식 App Server를 사용합니다. App Server가
읽기 메서드에서도 쓰기 가능한 runtime state를 초기화하므로, AXtory는 먼저 임시 private
`CODEX_HOME`에 일관된 SQLite backup을 생성합니다. 이후 `useStateDbOnly: true`를 지정한
`thread/list`와 `thread/read`만 호출합니다. 원본 Codex state database를 쓰기 모드로 열지
않으며 rollout JSONL을 직접 해석하지 않습니다.

내용을 제외한 구조 Spike를 실행하거나 History를 로컬에 수집할 수 있습니다.

```sh
npm run spike:codex
npm run build
node dist/src/cli.js collect-codex \
  --data-dir .local/axtory-codex \
  --json-out .local/axtory-codex/output.json
```

`--page-size`와 `--max-pages`는 active·archived 열거 범위를 제한합니다. 상한 도달, 반복 cursor,
중복, active thread, compaction event, non-full turn view는 명시적으로 partial 상태를 유지합니다.
Raw prompt, response, tool payload는 민감한 로컬 근거이므로 data directory를 공개하지 마세요.

## Claude Code Local History

공식 SDK를 별도로 설치한 다음 Collector를 실행합니다.

```sh
npm install --no-save --omit=optional @anthropic-ai/claude-agent-sdk@0.3.220
npm run build
node dist/src/cli.js collect-claude \
  --data-dir .local/axtory-claude \
  --json-out .local/axtory-claude/output.json
```

선택 인자 `--project-dir`, `--page-size`, `--max-pages`로 반환 view를 제한할 수 있습니다.
상한에 도달하면 `PARTIAL_PAGINATION`으로 보고하며 완전한 결과로 표시하지 않습니다.

이 명령은 공식 SDK를 통해 읽으며 Claude 설정을 변경하지 않습니다. 반환 view의 Prompt,
response, session metadata, tool payload는 민감정보이며 사용자 전용 권한을 적용한 로컬
content-addressed Blob Store에 저장합니다. Console·JSON summary에서는 Raw 값을 제외합니다.
`.local` data를 공개하지 마세요.

AXtory data directory 전체를 삭제하려면 marker로 보호되는 다음 명령을 사용합니다.

```sh
node dist/src/cli.js purge --data-dir .local/axtory-claude --confirm PURGE_ALL
```

`PURGE_ALL` 외에도 명시적인 mode를 사용하는 Raw/session 선택 삭제와 자동 Retention을
지원합니다. Vendor key를 노출하지 않고 opaque local ID를 확인할 수 있습니다.

```sh
node dist/src/cli.js list --data-dir .local/axtory-claude
node dist/src/cli.js delete --data-dir .local/axtory-claude \
  --mode DELETE_RAW_ONLY --revision-id revision_... --confirm DELETE_RAW_ONLY
node dist/src/cli.js retain --data-dir .local/axtory-claude \
  --classification CONVERSATION_CONTENT --days 30
```

`DELETE_RAW_AND_DERIVED`와 `DELETE_SOURCE_SESSION`에도 동일하게 정확한 확인 문자열이
필요합니다. 이 작업은 SQLite secure deletion과 WAL checkpoint를 적용하고, 참조되지 않는
Blob을 제거하며, 관련 Evidence 상태와 일치하는 pending live Spool 항목도 처리합니다.

## 추가 AI Source

Snapshot Collector는 Gemini CLI, OpenCode, Cursor Agent, Aider를 지원합니다. 실행 파일을
번들하거나 설정을 변경하지 않습니다.

```sh
npm run build
node dist/src/cli.js collect-additional-ai \
  --provider opencode --project-dir . \
  --data-dir .local/axtory-opencode --json-out .local/axtory-opencode/output.json

node dist/src/cli.js collect-additional-ai \
  --provider aider --project-dir . --history-file .aider.chat.history.md \
  --data-dir .local/axtory-aider --json-out .local/axtory-aider/output.json
```

다른 설치된 CLI는 `--provider gemini` 또는 `--provider cursor`로 선택하고, `--limit`으로
열거 범위를 제한합니다. 공식 읽기 인터페이스의 차이를 숨기지 않습니다.

| Provider | Source 계약 | Message·Tool fact |
| --- | --- | --- |
| OpenCode | JSON Session 목록과 export | 반환 export 범위에서 제공 |
| Gemini CLI | Session 목록 | `NOT_COLLECTED`, metadata만 수집 |
| Cursor Agent | Session 목록 | `NOT_COLLECTED`, metadata만 수집 |
| Aider | 명시적으로 지정한 chat-history Markdown | `NOT_SUPPORTED`, Raw log만 보관 |

대화 export와 Aider Markdown은 민감한 로컬 Blob으로만 보관합니다. Console·JSON 출력에는
집계 count, Availability, coverage, evidence 상태만 포함합니다. 계약 근거와 제한은
[`docs/research/additional-ai-contracts.md`](docs/research/additional-ai-contracts.md)를
참고하세요.

## 의미 분석과 Git 분석

하나 이상의 AI Source를 수집한 뒤 사용자용 Usage Report를 생성할 수 있습니다.

```sh
node dist/src/cli.js report-usage \
  --data-dir .local/axtory-codex \
  --json-out .local/axtory-codex/usage-report.json \
  --source codex
```

여러 Provider를 합치려면 `--source`를 반복하고, 수집된 모든 Session Source를 포함하려면
생략합니다. `--since`와 `--until`은 ISO-8601 시각을 받으며 원천 시각 기준 반개구간을 만듭니다.
리포트는 SourceObject별 최신 Revision만 사용하고 partial/unknown coverage를 드러내며, custom
extension 이름은 개인정보를 배제한 Tool 범주로 묶고 UTC 일별 활동은 JSON에 포함합니다.
schema v5 이전에 수집되어 observed head relation이 없는 Source는 명시적인 partial legacy
fallback으로 유지합니다. Count와 비율은 사용 패턴이지 생산성·품질·AI 효과가 아닙니다.

의미 범주는 기본적으로 꺼져 있습니다. 보존된 대화 내용을 로컬에서 읽어 좁은 Rule에 걸린
검증되지 않은 Assertion을 통합하려면 명시적으로 동의합니다. 한 번에 최대 100개 eligible
Revision만 분석하므로 이보다 크면 Source나 기간 범위를 줄입니다.

```sh
node dist/src/cli.js report-usage \
  --data-dir .local/axtory-codex \
  --json-out .local/axtory-codex/usage-report.json \
  --source codex --allow-conversation-content
```

기간이 제한된 리포트에서도 로컬 Rule Analyzer는 선택된 최신 Revision 전체를 읽지만, 리포트에는
기간 안 Message Evidence가 뒷받침하는 Assertion만 포함합니다.

Rule 분석은 사용자가 명시적으로 동의한 경우에만 보존된 대화 내용을 읽습니다. Assertion
match는 검증이 아니라 `INFERRED`입니다.

```sh
node dist/src/cli.js analyze-rule --data-dir .local/axtory-claude \
  --revision-id revision_... --allow-conversation-content
```

Local/remote model 연동은 Tool 권한이 없는 strict structured-result adapter를 사용합니다.
AXtory는 model provider를 번들하거나 설정하지 않습니다. Local Git 수집에서는 path, diff,
commit message, 작성자 신원을 제외합니다. 사용자가 선택한 session link는 시간 기반
상관관계일 뿐입니다.

```sh
node dist/src/cli.js collect-git --repo-dir . --data-dir .local/axtory \
  --json-out .local/axtory/git-output.json --session-revision-id revision_...
```

## 업무 시스템

GitHub와 GitLab은 Change Request, CI Run, Deployment를 제공합니다. Jira와 Linear는 Work
Item을 제공합니다. 수집에는 공식 HTTPS API, 제한된 pagination, 불변 Revision, 작은 metadata
allowlist를 사용합니다. 지원하지 않는 Artifact 종류는 0이 아니라 `NOT_SUPPORTED`입니다.

```sh
npm run build
node dist/src/cli.js collect-work-system \
  --provider github --repository OWNER/REPOSITORY \
  --data-dir .local/axtory-work --json-out .local/axtory-work/github.json

node dist/src/cli.js collect-work-system \
  --provider gitlab --project GROUP/PROJECT \
  --data-dir .local/axtory-work --json-out .local/axtory-work/gitlab.json

node dist/src/cli.js collect-work-system \
  --provider jira --base-url https://example.atlassian.net --project AX \
  --data-dir .local/axtory-work --json-out .local/axtory-work/jira.json

node dist/src/cli.js collect-work-system \
  --provider linear --team-id TEAM_ID \
  --data-dir .local/axtory-work --json-out .local/axtory-work/linear.json
```

해당 명령을 실행하기 전에 Shell의 secret 기능으로 `GITHUB_TOKEN`, `GITLAB_TOKEN`,
`JIRA_EMAIL`/`JIRA_API_TOKEN`, `LINEAR_API_KEY`를 설정하세요. 공개 GitHub·GitLab 저장소는
API 제한 범위에서 Token 없이도 읽을 수 있습니다. 다른 환경변수명을 사용하려면
`--token-env`와 Jira의 `--email-env`를 지정하세요. Credential literal 인자는 거부합니다.
`--page-size`와 `--max-pages`로 열거 범위를 제한할 수 있습니다.

PR/CI/Deployment의 명시적 commit identity를 이전에 수집한 Local Git snapshot과 연결하려면
`--git-revision-id revision_...`을 전달합니다. 일치 관계는 `OBSERVED`입니다. AXtory는 Work
Item↔PR 관계를 추론하거나 작성, 인과, 완료, AI 기여를 주장하지 않습니다.

## 선택적 Live Hook·OTel 수집

사용자가 Receiver를 시작하고 Claude 설정 변경을 명시적으로 승인하기 전까지 Live 수집은
꺼져 있습니다. Receiver는 IPv4 loopback에서 인증된 HTTP Hook과 OTLP `http/json` 요청을
받고, 크기가 제한되고 crash 복구가 가능한 Spool에 기록하며 content-bearing OTel gate를
비활성화합니다.

```sh
node dist/src/cli.js plan-live --settings /path/to/claude/settings.json \
  --enable-hooks --enable-otel
node dist/src/cli.js serve-live --data-dir .local/axtory-live \
  --settings /path/to/claude/settings.json --enable-hooks --enable-otel \
  --confirm APPLY_CLAUDE_LIVE_CONFIG
```

Receiver를 중지한 뒤 Spool을 ingest하고, 설정 과정에서 출력된 정확한 backup path로
복구합니다.

```sh
node dist/src/cli.js ingest-live --data-dir .local/axtory-live \
  --json-out .local/axtory-live/output.json
node dist/src/cli.js rollback-live --settings /path/to/claude/settings.json \
  --backup /path/to/.axtory-backups/settings-....json \
  --confirm ROLLBACK_CLAUDE_LIVE_CONFIG
```

Token, model, 추정 cost, latency fact는 OTel channel별 namespace로 분리합니다. 누락된 범주는
`NOT_COLLECTED`로 유지하며 Vendor 추정 비용을 실제 billing 값으로 취급하지 않습니다.

## 기술 MVP의 Non-goal

AXtory는 Agent를 실행하지 않으며, 업무를 자동 그룹화하거나 ROI를 추정하거나 AI 기여
백분율을 부여하지 않습니다. Hook·OpenTelemetry를 자동 활성화하지 않고, 의미 분석 model
provider나 Public Connector Plugin SPI도 제공하지 않습니다.

## 기여 및 보안

Code나 Fixture를 제출하기 전에 [`CONTRIBUTING.md`](CONTRIBUTING.md)를 확인하세요. 실제
Claude·Codex session을 Issue에 첨부하지 마세요. 보안 문제 보고 방법은
[`SECURITY.md`](SECURITY.md)에 있습니다.

## 라이선스

AXtory는 Apache License 2.0으로 배포됩니다. Vendor 제품과 SDK는 각각 별도 라이선스를
따르며 이 저장소에서 재배포하지 않습니다.
