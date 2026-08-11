# Connector contract research

Research date: 2026-08-09

This document distinguishes official guarantees, local observations, assumptions, and spike
work. Official interfaces outrank local storage details.

## Claude Code

### Verified from official documentation

- TypeScript Agent SDK exposes `listSessions()`, `getSessionMessages()`, and
  `getSessionInfo()` for local history.
- Session metadata includes a stable session UUID, last-modified time, and optional cwd,
  branch, creation time, title, first prompt, and local file size.
- A history message has role, UUID, session ID, raw unknown payload, and a nullable
  `parent_tool_use_id`; the TypeScript reference associates that parent with a spawning Agent
  tool for subagent messages.
- Sessions are stored continuously and can be resumed or forked. Concurrent resume can
  interleave into one transcript, so a session is not equivalent to one execution run.
- `CLAUDE_CONFIG_DIR` relocates settings, credentials, history, and plugins. Local transcripts
  are plaintext and retained for 30 days by default.
- Hooks and OTel are opt-in configuration changes. Content-bearing telemetry is redacted by
  default and requires separate gates.
- HTTP hooks POST the command-hook JSON input and treat connection/non-2xx failures as
  non-blocking. Header environment interpolation requires an explicit `allowedEnvVars` entry.
- OTel supports per-signal OTLP `http/json` endpoints. Prompt, tool detail/content, and raw API
  body logging are separate opt-in gates; AXtory's generated configuration forces them off.

Sources:

- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/data-usage
- https://code.claude.com/docs/en/monitoring-usage

### Local observation

- Same-environment executable: Claude Code 2.1.226 on WSL2 Linux x86_64.
- `claude auth status --json` exits successfully and reports logged-in state. AXtory retained no
  email, organization ID/name, or account identifier.
- The default probe had no `CLAUDE_CONFIG_DIR`. A second controlled probe used an isolated empty
  config root: the SDK returned zero sessions with complete returned-view coverage and did not
  mix sessions from the default root; authentication was explicitly unavailable.
- The TypeScript Agent SDK was not installed before the spike. Version 0.3.220 was then installed
  only in the local development environment and successfully loaded alongside CLI 2.1.226.
- The bounded official-API read returned 25 sessions, so session coverage is `PARTIAL_LIMIT`.
  Six returned message views reached the 200-message limit and are also `PARTIAL_LIMIT`.
- Returned message envelopes exposed `timestamp`, `type`, and an undocumented
  `parent_agent_id` key. Tool block type labels included `thinking`, `text`, `tool_use`, and
  `tool_result`. No payload values or identifiers were retained in the report.
- None of the bounded returned messages had a populated `parent_tool_use_id`. This is absence in
  the sampled view, not evidence that subagent lineage is unsupported.

### Lineage read across a full local history

A structural read of the complete retained local history — 265 sessions and 24917 messages, keys
and hashes only, no content — settled the lineage rows the earlier bounded sample could not.

- The session view exposes nine keys: `sessionId`, `createdAt`, `lastModified`, `fileSize`, `cwd`,
  `gitBranch`, `summary`, `firstPrompt`, and `customTitle`. None of them references another
  session, so there is no field from which a session-level relation could be read.
- `parent_agent_id` and `parent_tool_use_id` are present on all 24917 messages and null on every
  one. The earlier "absence in the sampled view" holds across the whole history.
- The history contains 43 `Agent` invocations, so subagents did run. They produced no additional
  session and no populated parent. Claude keeps subagent work inside the invoking session as tool
  occurrences, which is the opposite of Codex, where a spawn becomes its own thread that names its
  parent. There is no Claude equivalent of `SUBAGENT_OF` to record.
- Message `type` took only `user`, `assistant`, and `system` while `includeSystemMessages: true`
  was set, and `message.session_id` never differed from the owning session. Neither compaction nor
  continuation is marked.
- 25 opening prompts recur across sessions and the largest group holds 9, but no session's message
  sequence is a prefix of another's in any of the 113 multi-message sessions. Repeated openings are
  therefore duplicate content, and treating them as lineage would have manufactured 25 relations.
  The controlled run below shows what a real fork looks like and why this history contains none.
- 152 of the 265 sessions hold exactly one user message, no assistant reply, and no `customTitle`.
  These are abandoned openings. They are genuine sessions, but they dominate the per-session
  distributions in the usage report, where the median message count is 1.
- Only one collection run exists, so every session has one revision. Whether resuming extends an
  existing `sessionId` rather than creating a new one needs a second collection taken after a
  controlled resume; a single snapshot cannot show growth.
- `cwd` (12 distinct) and `gitBranch` (22 distinct) are the only workspace signals the session view
  carries. AXtory does not currently read either, and both are path- and name-bearing, so capturing
  them would require hashing under the same rule the Local Git collector already follows.

### Controlled resume and fork session

Three bounded `claude -p` runs on CLI 2.1.227 with SDK 0.3.220, read back through the official API.
The isolated `CLAUDE_CONFIG_DIR` probe cannot be used here because an isolated root has no
credentials, so the runs used the default root and are real sessions.

- Resuming with `--resume` returned the **same** `sessionId` and appended to it. A resumed
  conversation is one session that grew, which is why no prefix pair exists in the local history and
  why no resume relation is available or needed.
- `--fork-session` minted a **new** `sessionId`. Neither session view names the other: both expose
  the same ten keys, `getSessionInfo` adds nothing, and no message in the child contains the parent
  id anywhere in its JSON.
- The child nevertheless replays the parent. Its first 6 message contents matched the parent's 6
  exactly, and all 6 carried the **same `uuid`** the parent had. The copied messages' `session_id`
  is rewritten to the child, so the shared `uuid` is the only surviving link.
- A fork is therefore observable through Vendor-assigned message identity rather than through
  content resemblance, and detecting it needs a cross-session comparison the per-session normalizer
  does not currently perform. Whether AXtory should emit `FORKED_FROM` from shared message identity
  is an open design decision: the identity is Vendor data, but the relation is inferred from an
  implementation detail rather than read from a declared field.

### Controlled live emission

A bounded session ran with `claude --settings <isolated file>` against a temporary project, so the
receiver was reached with real credentials while the user's global settings were never read or
written; their digest was identical before and after. The generated settings were then restored
byte-for-byte with `rollback-live`.

- Six requests arrived: three Hook posts and three OTLP bodies (two logs, one metrics).
- Real Hook payloads carry more than the documented minimum. `PostToolUse` includes `tool_input`,
  `tool_response`, `tool_use_id`, `duration_ms`, `cwd`, and `transcript_path`; `Stop` includes
  `last_assistant_message`; all three include `session_id`, `prompt_id`, and `permission_mode`.
  Undocumented keys also appeared: `effort`, `background_tasks`, `session_crons`,
  `stop_hook_active`, and `reason`.
- The normalizer allowlist held against that real payload. Canonical observations contained no cwd,
  transcript path, tool input or response, assistant message, or read file content; session and
  tool-use identifiers were hashed.
- Normalization produced token, model, estimated cost, and latency facts on both the event and the
  metric channel, each reported separately rather than combined.

### Gaps

| Question | Classification | Handling |
| --- | --- | --- |
| ToolUse/ToolResult block presence | VERIFIED | Official API returned both type labels; payload schema remains untrusted/unknown. |
| Per-message timestamp key | VERIFIED | Key observed locally; optionality and semantics still require synthetic contract tests. |
| `parent_agent_id` meaning/stability | VERIFIED/NEGATIVE | A bounded read of 265 local sessions found the key present on all 24917 messages and null on every one, including the 113 sessions holding 43 `Agent` invocations. The field carries no observed parent in history reads. |
| Active-session snapshot consistency | NEEDS_SPIKE | Hash returned views and report bounded coverage. |
| Resume boundaries within one session | NOT_SUPPORTED | Keep SessionRun separate; return UNKNOWN. |
| Fork lineage in history reads | VERIFIED | A controlled `--fork-session` creates a new session that declares no parent in any field, but copies the parent's messages keeping their Vendor-assigned `uuid` while rewriting `session_id` to the child. Lineage is therefore derivable from shared message identity, not from content resemblance. |
| Compaction boundary in archival reads | VERIFIED/NEGATIVE | Message `type` took only `user`, `assistant`, and `system` across 24917 messages, with `includeSystemMessages: true`. No boundary marker is exposed. |
| Custom config behavior in SDK reads | VERIFIED | Isolated empty root returned zero sessions and did not expose default-root history. |
| SDK 0.3.220 with CLI 2.1.226 | VERIFIED | Local bounded read succeeded; no broader compatibility matrix is inferred. |

The public fixtures for normal, resumed, tool-heavy, compacted, active, missing-field,
custom-config, corrupted-source, and unsupported-version cases will be synthetic. No personal
session becomes a fixture.

### Contract spike test matrix

| Contract | Current status | Acceptance criterion |
| --- | --- | --- |
| Installation and version discovery | VERIFIED | Same-environment executable and SemVer are reported without shell parsing. |
| Default data root | VERIFIED | Root availability is probed; path is not written to the shared Spike report. |
| `CLAUDE_CONFIG_DIR` discovery | VERIFIED | Discovery and isolated official SDK read both used the custom root. |
| Session enumeration and bounded coverage | VERIFIED | Limit hits are `PARTIAL_LIMIT`, never complete or zero-filled. |
| Session metadata optionality | VERIFIED_BY_TEST | Missing timestamp/source-modified fields remain unavailable and are not replaced with collection time. |
| Message UUID/ID exclusion | VERIFIED_BY_TEST | Fake identifiers and sensitive values cannot enter the report. |
| Message order | NEEDS_SPIKE | Controlled fixture must establish ordering and pagination overlap behavior. |
| ToolUse/ToolResult presence | VERIFIED | Only allowlisted type labels are retained; payloads are excluded. |
| Resume and fork lineage | VERIFIED | Controlled sessions separated the two. Resume keeps the same `sessionId` and grows it, so there is nothing to relate. Fork mints a new `sessionId` whose messages repeat the parent's `uuid` values, which is Vendor-assigned identity rather than duplicate content. |
| Long session | VERIFIED | Returned 200-message views are explicitly partial. |
| Compaction | PARTIAL_CAPABILITY | Synthetic contract preserves `PARTIAL_COMPACTION`; real system-message semantics are not inferred. |
| Active session | VERIFIED_BY_TEST | Post-read metadata changes produce `PARTIAL_SOURCE_CHANGED`; a controlled real active session remains pending. |
| Git worktree | PARTIAL_CAPABILITY | Official option is forwarded with `includeWorktrees: true`; controlled session-bearing worktree remains pending. |
| Subagent lineage | VERIFIED/NEGATIVE | 43 `Agent` invocations produced no additional session and no non-null `parent_agent_id`. Unlike Codex, subagent work stays inside the invoking session as tool occurrences, so there is no session-level link to record. |
| Corruption and unsupported version | VERIFIED_BY_TEST/PARTIAL | Corrupted and unsupported-schema fixtures fail explicitly; controlled Vendor SDK/CLI version cases remain pending. |
| HTTP Hook receiver | VERIFIED | A controlled session with CLI 2.1.226 delivered real `PostToolUse`, `Stop`, and `SessionEnd` posts to the loopback receiver. Isolation used `claude --settings <file>`, so no global configuration was read or written. |
| OTLP `http/json` metrics/logs | VERIFIED | The same session delivered real logs and metrics that normalized to token, model, estimated cost, and latency facts across both channels. gRPC/protobuf and traces remain unsupported. |

`VERIFIED_BY_TEST` means a synthetic unit/contract test validated AXtory behavior, not that the
installed Vendor implementation was exercised for that scenario.

## Codex design reconnaissance

Official OpenAI documentation verifies that App Server exposes `thread/list` and
`thread/read`; `thread/read` can include turns without resuming or subscribing to the thread.
The stdio transport is newline-delimited JSON without a `jsonrpc` header and requires
`initialize` followed by `initialized`. `thread/list` uses opaque cursor pagination, defaults to
interactive source kinds when the filter is omitted, and offers `useStateDbOnly: true` to avoid
scanning rollout JSONL to repair metadata. Stored-turn pagination is experimental, so AXtory does
not use it. OTel and Hooks are disabled by default or require explicit configuration.

Sources:

- https://developers.openai.com/codex/app-server/
- https://developers.openai.com/codex/config-advanced/
- https://developers.openai.com/codex/hooks/

### Local observation

- Same-environment executable: Codex CLI 0.147.0 on WSL2 Linux x86_64.
- `codex login status` exited successfully. AXtory retained no account identifier or credential.
- Starting App Server against the original sandbox-read-only `CODEX_HOME` failed while
  initializing its SQLite state runtime. Therefore a read-only method set does not imply a
  write-free process lifecycle.
- Node's SQLite online backup successfully copied the live state DB into a private temporary
  `CODEX_HOME`. App Server then initialized there and `thread/list(useStateDbOnly: true)` plus
  `thread/read(includeTurns: true)` succeeded while the original tree remained read-only.
- A bounded report enumerated five threads and structurally inspected 55 full turns. Observed item
  type labels were `userMessage`, `agentMessage`, `fileChange`, `webSearch`, `subAgentActivity`,
  and `contextCompaction`. No content, IDs, paths, cwd, titles, model values, or tool payloads were
  retained in the report.
- A later bounded read covered 189 threads and 1666 full turns. It added no new item type and
  contained 609 `contextCompaction` items, so compaction is common rather than incidental.
- 126 of those threads are spawned subagents. Every one declares its parent at
  `source.subAgent.thread_spawn.parent_thread_id`; none populates the top-level `parentThreadId`.
  The spike report reads `thread/list`, where `forkedFromId` is null, while the collector reads
  `thread/read`, where the same spawn parent is repeated in `forkedFromId`. The spike's zero fork
  count therefore did not mean the collector produced none.
- The same object carries `depth`, `agent_path`, `agent_nickname`, and `agent_role`. Only the
  parent id is read, and it is hashed before it reaches a canonical observation.
- No active thread appeared in the sample. That remains absence in the sample, not evidence that
  active threads do not occur.

### Contract status

| Contract | Current status | Handling |
| --- | --- | --- |
| App Server lifecycle | VERIFIED | Isolated state snapshot is mandatory; direct original-home startup is rejected by design. |
| `thread/list` cursor pagination | VERIFIED_BY_TEST/PARTIAL | Cursor advance, repeat detection, max-page bound, duplicate handling, archive split tested. |
| source kind coverage | VERIFIED | Current generated schema kinds are explicit; future unknown kinds require compatibility review. |
| `useStateDbOnly` | VERIFIED | Forced on every list call; metadata repair scan is never requested. |
| `thread/read` returned turns | VERIFIED | Installed App Server returned full turns without resume/subscription. |
| active thread consistency | VERIFIED_BY_TEST/PARTIAL | Active or changed list/detail metadata is partial; controlled live mutation remains pending. |
| subagent lineage | VERIFIED | A bounded read of 189 threads found 126 spawned subagents. All declare `source.subAgent.thread_spawn.parent_thread_id` and none populate the top-level `parentThreadId`. AXtory reads the nested field and hashes it. |
| fork vs spawn | VERIFIED | A spawned subagent repeats its parent in `forkedFromId`, so App Server implements spawning as a fork. Only `SUBAGENT_OF` is emitted for that link; a `forkedFromId` pointing elsewhere still yields `FORKED_FROM`. |
| compaction | VERIFIED/PARTIAL | Event type observed; returned view is marked partial, semantics are not reconstructed. |
| internal JSONL parsing | NOT_SUPPORTED | App Server reads the rollout; AXtory never parses it. |
| experimental turn pagination | NOT_SUPPORTED | Stable whole-thread read is used until the paged API stabilizes. |

Phase 8 is implemented. The cross-Vendor minimum is recorded only as a Public SPI candidate;
no exported plugin contract is declared.

## Vendor dependency boundary

The TypeScript Claude Agent SDK repository states that it is subject to Anthropic Commercial
Terms and its package can install platform-specific Claude Code binaries. AXtory therefore
does not declare it as a runtime or peer dependency, does not bundle it, and does not publish
its binary. The spike dynamically loads a separately installed SDK and uses the user's existing
`claude` executable.

Codex uses the separately installed `codex` executable and its App Server protocol. AXtory does
not bundle the executable, generated protocol package, or a Codex SDK. Version-specific generated
schemas were inspected during the Spike but were not copied into the repository.
