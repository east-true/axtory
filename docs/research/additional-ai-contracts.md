# 추가 AI Source Connector 계약 조사

기준일: 2026-08-10

상태: 공식 계약 조사 완료 / 전체 adapter `VERIFIED_BY_TEST` / Aider CLI 경로 로컬 검증

## 범위와 판정 원칙

Phase 10은 Gemini CLI, OpenCode, Cursor Agent, Aider가 공식적으로 제공하는 비파괴 읽기
경로만 사용한다. 네 제품을 하나의 가상 공통 대화 API로 보정하지 않는다. Session 목록만
제공하면 metadata만 수집하고, 구조화되지 않은 Markdown은 Message 경계를 추측하지 않는다.

| Provider | 공식 읽기 경로 | AXtory 보존 범위 | Coverage/Availability |
| --- | --- | --- | --- |
| Gemini CLI | `gemini --list-sessions` | 해시한 Session identity | `METADATA_ONLY`, Message/Tool `NOT_COLLECTED` |
| OpenCode | `session list --format json`, `export <id>` | 로컬 Raw export, Message identity, Tool occurrence | 반환 view 기준 complete 또는 명시적 partial |
| Cursor Agent | `cursor-agent ls` | 해시한 Session identity | `METADATA_ONLY`, Message/Tool `NOT_COLLECTED` |
| Aider | 명시한 `.aider.chat.history.md` | 로컬 Raw Markdown | Message/Tool `NOT_SUPPORTED`, 전체 구조 coverage `UNKNOWN` |

공식 근거:

- Gemini CLI: [Session management](https://geminicli.com/docs/cli/session-management/),
  [CLI configuration and options](https://geminicli.com/docs/reference/configuration/)
- OpenCode: [CLI reference](https://opencode.ai/docs/cli/),
  [official CLI source](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/cli.mdx),
  [export command source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/export.ts)
- Cursor: [CLI overview](https://docs.cursor.com/en/cli/overview),
  [using the CLI](https://docs.cursor.com/en/cli/using),
  [output format](https://docs.cursor.com/en/cli/reference/output-format)
- Aider: [configuration options](https://aider.chat/docs/config/options.html),
  [configuration file](https://aider.chat/docs/config/aider_conf.html),
  [chat history guidance](https://aider.chat/docs/faq.html)

## Provider별 계약

### Gemini CLI

공식 Session 관리 명령은 현재 프로젝트의 Session을 목록으로 표시하고 resume/delete 기능을
제공한다. AXtory는 `--list-sessions` 출력의 bracket Session ID만 허용 목록으로 읽고 같은 줄의
preview 문자열은 즉시 버린다. 공식 문서에 기존 Session 대화를 비대화형 구조 JSON으로
내보내는 계약이 없으므로 resume를 호출하거나 로컬 내부 저장 형식을 해석하지 않는다.

### OpenCode

공식 CLI는 pure 출력, JSON Session 목록, Session export를 제공한다. AXtory는 목록을
`limit + 1`로 요청해 상한 도달을 감지하고, export의 `{ info, messages }` 구조를 검증한다.
목록과 export 사이 updated timestamp가 달라지면 `PARTIAL_SOURCE_CHANGED`다. 자동 update,
prune, share는 명령 환경에서 비활성화한다. Message content는 identity hash와 part type만
정규화하고 전체 JSON은 민감한 로컬 Raw Revision으로 보관한다.

### Cursor Agent

공식 CLI는 `cursor-agent ls`로 과거 chat을 보고 resume할 수 있다. 문서화된 JSON output은
print-mode 실행 결과용이며 과거 목록/대화의 구조화 export 계약으로 문서화되지 않았다.
AXtory는 목록에서 완전한 UUID만 읽고 preview는 버린다. resume는 Source를 실행·변경할 수
있으므로 수집에 사용하지 않는다.

### Aider

Aider는 chat history Markdown 파일 경로를 설정하고 보존할 수 있음을 문서화한다. AXtory는
사용자가 명시한 파일만 읽으며 Aider 실행 파일이 없어도 이 문서화 저장 경로를 수집할 수
있다. Markdown heading이나 prompt 모양을 Message schema로 추측하지 않는다. 목록의 mtime과
읽기 뒤 mtime이 다르면 `PARTIAL_SOURCE_CHANGED`, 같아도 구조적 완전성은 `UNKNOWN`이다.

## 데이터·실행 경계

- 모든 CLI 실행은 shell 없이 argument array로 수행하고 cwd, timeout, output size를 제한한다.
- Vendor 설정, Session, history 파일을 수정하지 않는다.
- Raw export/Markdown에는 대화 내용이 있으므로 `CONVERSATION_CONTENT`로 로컬 Blob Store에
  저장한다. Gemini/Cursor summary는 `LOCAL_METADATA`다.
- Console/JSON에는 Provider, coverage, Revision 집계, count metric, Availability, reason,
  evidence count/status만 내보낸다. Session ID, path, prompt, response, tool payload는 제외한다.
- Source timestamp가 같은 반복 수집은 기존 Revision을 재사용한다. limit 또는 원천 변경을
  완전한 이력으로 표시하지 않는다.

## 검증 상태와 제한

- 네 adapter는 공식 문서/소스 응답 shape를 고정한 합성 contract test를 통과했다.
- Aider는 임시 Markdown 파일에서 실제 child-process CLI → Discovery → Raw/Revision → Fact →
  JSON 경로와 반복 수집을 검증했다. 이 검증은 Aider 실행 파일 자체를 실행한 것이 아니다.
- 감사 환경에는 `gemini`, `opencode`, `cursor-agent`, `aider` 실행 파일이 없었다. 따라서
  Gemini/OpenCode/Cursor의 설치된 실제 버전 smoke와 Aider가 생성한 실제 history 표본은
  수행하지 않았다.
- Vendor가 출력 형식을 바꾸면 조용히 빈 결과로 처리하지 않고 schema/format error로 실패한다.
  합성 테스트는 향후 모든 Vendor 버전이나 사용자의 전체 history를 보증하지 않는다.
