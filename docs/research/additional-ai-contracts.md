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
- 이후 Gemini CLI 0.54.4, OpenCode 1.18.16, Aider 0.86.2를 실제로 설치해 discovery와 명령
  호환성을 확인했고, Aider가 실제 생성한 history를 수집했다. 자격증명이 없어 대화가 있는
  Session 목록과 OpenCode export 본문은 여전히 미검증이며 content 계약은 합성 test 근거다.
  `cursor-agent`는 공식 배포가 원격 install script뿐이라 설치하지 않았다.
- Vendor가 출력 형식을 바꾸면 조용히 빈 결과로 처리하지 않고 schema/format error로 실패한다.
  합성 테스트는 향후 모든 Vendor 버전이나 사용자의 전체 history를 보증하지 않는다.

## 후보 Source 조사: Kimi Code, GitHub Copilot CLI, Muse Code

조사일: 2026-08-10. 아직 구현 대상이 아니며 Connector 편입 가능성만 판정한다.

판정 기준은 기존과 같다. 공식 문서로 고정된 비파괴 읽기 경로가 있어야 하고, 문서화되지 않은
Vendor 저장물을 추측해 parsing하지 않는다.

| 후보 | 공식 읽기 경로 | 판정 |
| --- | --- | --- |
| Kimi Code | 문서화된 `$KIMI_CODE_HOME`(기본 `~/.kimi-code`)의 `session_index.jsonl`, `sessions/<workDirKey>/<sessionId>/state.json`, `agents/main/wire.jsonl` | **구현함.** 실제 설치본 0.34.0으로 명령 존재를 확인했고 문서화된 wire schema로 Message·Tool까지 정규화한다. |
| GitHub Copilot CLI | 없음. 1.0.78의 하위 명령은 completion/help/init/login/mcp/plugin/plugins/skill/update/version뿐이고 세션 목록·export 명령이나 플래그가 없다. `--continue`와 `--connect`로 세션이 유지됨은 확인되지만 저장 형식은 문서화돼 있지 않다. | `NOT_SUPPORTED`. 문서화되지 않은 저장물을 parsing하지 않는다는 규칙에 걸린다. |
| Muse Code | `muse export`가 세션 하나의 durable log를 `export_schema_version 1` JSON 한 문서로 내보낸다. `--last`/`--out`으로 비대화형 실행이 되고 help가 "reads only local files; no network access"를 명시한다. `muse trace inspect --session-log <jsonl> --format json`도 있다. | `PROPOSED`. 읽기 경로는 확인했으나 export 문서의 필드명이 공개돼 있지 않다. |

세 후보 모두 공식 배포가 원격 install script(`curl … | bash`)다. npm에서 이름이 겹치는
`kimi-cli`, `kimi-code`, `cursor-agent`는 모두 무관한 서드파티 패키지이므로 설치 대상이 아니다.
공식 경로 외 설치는 검증을 오염시킨다.

### Kimi Code 실제 설치 확인 (0.34.0)

공식 install script는 `code.kimi.com` 한 도메인에서만 내려받고 SHA256을 검증하며 기본 설치
위치가 `$HOME/.kimi-code`라 권한 상승이 필요 없다. 기본 동작이 shell rc에 PATH를 덧붙이므로
검증에는 `KIMI_NO_MODIFY_PATH=1`을 써서 사용자 rc를 바꾸지 않았다.

- 문서가 말한 `--session`, `--continue`, `export`, `vis`가 실제로 존재한다.
- `kimi export`는 `-y`로 확인 절차를 건너뛰고 `-o`로 출력 경로를 지정할 수 있어 비대화형
  child-process 수집에 적합하다.
- **`--no-include-global-log`가 필요하다.** export는 기본적으로 전역 진단 로그
  `~/.kimi-code/logs/kimi-code.log`를 함께 묶는다. 이는 대상 Session 범위를 넘어서므로
  Connector는 이 플래그를 반드시 지정해 export를 한 Session으로 한정해야 한다.
- Session이 없으면 `export`가 exit 1과 `No previous session found to export.`로 끝난다.
  빈 결과를 성공으로 위장하지 않으므로 Availability 판정에 그대로 쓸 수 있다.
- `sessions/` 디렉터리는 지연 생성이라 미사용 설치에서는 없다. 부재를 수집 실패로 다루면 안 된다.
- 산출물이 ZIP이므로 export 경로를 쓰면 압축 해제가 필요하다. Node 기본 모듈에 ZIP reader가
  없어 Core 의존성 0 원칙과 충돌하므로, Connector는 export 대신 문서화된 저장소를 직접 읽는다.
  같은 이유로 전역 진단 로그가 함께 묶이는 문제도 발생하지 않는다.

자격증명이 없어 실제 Session을 만들지 못했으므로 `state.json`과 `wire.jsonl`의 실제 내용은
검증하지 않았다.

출처: <https://www.kimi.com/code>, <https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html>,
<https://github.com/github/copilot-cli>, <https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2>

### Kimi Code Connector 구현 계약

`wire.jsonl`은 JSON-RPC 2.0이며 공식 Wire mode 문서가 method와 event 이름을 고정한다. 문서에
있는 이름만 읽는다.

| 문서화된 항목 | Canonical 처리 |
| --- | --- |
| `prompt` request | USER Message occurrence |
| `ContentPart` event | ASSISTANT Message occurrence, part type만 보존 |
| `ToolCall`, `ToolResult` event | Tool occurrence |
| `CompactionBegin` event | coverage `PARTIAL_COMPACTION` |
| `state.json` | createdAt/updatedAt만 사용, 키 이름은 문서에 없어 여러 표기를 허용하고 실패 시 unavailable |
| `session_index.jsonl` | `workDir`로 프로젝트 범위 filter, `sessionDir`로 세션 위치 확인 |

경계 규칙은 다음과 같다.

- 인식하지 못한 line은 의미를 추론하지 않는다. 다만 line이 있는데 문서화된 event가 하나도 없으면
  형식 변경이므로 실패한다. 빈 세션으로 위장하지 않는다.
- `agents/main/wire.jsonl`이 없으면 coverage `UNKNOWN`이며 Message 0건이 아니다.
- `session_index.jsonl` 부재는 최초 세션 이전 상태이므로 빈 이력이고 수집 실패가 아니다.
- index가 `$KIMI_CODE_HOME` 밖을 가리키면 거부한다. index는 Vendor 데이터다.
- prompt·응답·tool payload·경로·Session ID는 Canonical 관찰과 출력에 넣지 않고 content는 hash만
  남긴다. Raw는 `CONVERSATION_CONTENT`로 로컬 Blob Store에만 보관한다.
- Rule Semantic extractor는 아직 없다. `analyze-rule`은 명시적 오류로 끝나고 Usage Report는
  `NOT_SUPPORTED`로 표시한다.

**미검증:** 자격증명이 없어 실제 Session을 만들지 못했다. 계약 test는 공식 문서 shape 기반
합성 데이터이며 실제 `state.json`·`wire.jsonl` 표본으로는 확인하지 않았다.

### Muse Code 실제 설치 확인 (0.1.0-R708.1)

첫 조사에서 `NEEDS_SPIKE`로 둔 근거는 "문서가 개발자 포털 로그인 뒤"였다. 이는 절반만 맞았다.
웹 문서는 여전히 로그인 뒤지만 CLI 자체의 `--help`가 공개된 계약 원본이고, 설치 스크립트도
`https://dev.meta.ai/install.sh`로 공개돼 있다. 그래서 판정을 `PROPOSED`로 올린다.

설치 스크립트는 `api.meta.ai` 한 도메인에서만 받고 `x-content-sha256` 헤더와 대조해 검증하며
기본 위치가 `$HOME/.local/bin`이라 권한 상승이 없다. 기본 동작이 shell profile에 PATH를 넣으므로
검증에는 `MUSE_NO_MODIFY_PATH=1`과 `MUSE_INSTALL_DIR`로 사용자 rc를 바꾸지 않았다. 설치물은
launcher script이고 최초 실행 시 실제 바이너리를 내려받는 2단계 구조다.

- `muse export [--session <id|path>] [--last] [--out <file>] [--redacted]`가 세션 하나의 durable
  log를 자체 완결 JSON 한 문서로 내보낸다. `export_schema_version 1`로 스키마가 버전화돼 있다.
- help가 "Offline: reads only local files; no network access"를 명시한다. AXtory가 요구하는
  비파괴·오프라인 읽기 보증이 Vendor 문서로 고정된 셈이다.
- 산출물이 JSON이라 Kimi의 ZIP과 달리 압축 해제 의존성이 필요 없다.
- 대화형 터미널에서 `--session` 없이 실행하면 picker가 뜨지만, 출력이 pipe이거나 `--out`/`--last`를
  주면 비대화형으로 동작한다. child-process 수집에는 `--last --out`을 쓴다.
- `--redacted`는 telemetry redaction 규칙을 적용한 share-safe 변형이다. 기본은 RAW다.
- 세션이 없으면 exit 1과 `no retained sessions found for this workspace`로 끝난다. 빈 결과를
  성공으로 위장하지 않는다. 세션은 workspace 단위로 범위가 나뉜다.
- `muse trace inspect --session-log <jsonl> --format json`이 두 번째 읽기 경로다.

**구현 보류 사유:** export 문서가 담는 항목은 help가 열거하지만(timestamps, messages, tool
calls/results, approvals, question outcomes, model ids, ses_/trajectory_ ids, fork/subagent
lineage) 필드명은 공개돼 있지 않다. help가 참조하는 `docs/session-export.md`는 설치물에
포함되지 않고 웹 문서는 로그인 뒤다. 바이너리에서 문자열을 추출해 필드명을 알아내는 것은
문서화되지 않은 Vendor 형식의 역공학이므로 하지 않는다. 필드명이 공개되거나 실제 export 표본을
얻기 전에는 normalizer를 쓰지 않는다.
