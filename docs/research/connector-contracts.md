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

### Gaps

| Question | Classification | Handling |
| --- | --- | --- |
| ToolUse/ToolResult block presence | VERIFIED | Official API returned both type labels; payload schema remains untrusted/unknown. |
| Per-message timestamp key | VERIFIED | Key observed locally; optionality and semantics still require synthetic contract tests. |
| `parent_agent_id` meaning/stability | PARTIAL | SDK 0.3.220 types document parent agent semantics; cross-version stability still needs a subagent Spike. |
| Active-session snapshot consistency | NEEDS_SPIKE | Hash returned views and report bounded coverage. |
| Resume boundaries within one session | NOT_SUPPORTED | Keep SessionRun separate; return UNKNOWN. |
| Fork lineage in history reads | NEEDS_SPIKE | Do not infer from duplicate content. |
| Compaction boundary in archival reads | NEEDS_SPIKE | Preserve unknown raw structures. |
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
| Resume and fork lineage | NEEDS_SPIKE | Controlled sessions must distinguish lineage from content duplication. |
| Long session | VERIFIED | Returned 200-message views are explicitly partial. |
| Compaction | PARTIAL_CAPABILITY | Synthetic contract preserves `PARTIAL_COMPACTION`; real system-message semantics are not inferred. |
| Active session | VERIFIED_BY_TEST | Post-read metadata changes produce `PARTIAL_SOURCE_CHANGED`; a controlled real active session remains pending. |
| Git worktree | PARTIAL_CAPABILITY | Official option is forwarded with `includeWorktrees: true`; controlled session-bearing worktree remains pending. |
| Subagent lineage | PARTIAL_CAPABILITY | SDK types document parent fields, but no sampled parent link exists; no Core relation is emitted. |
| Corruption and unsupported version | VERIFIED_BY_TEST/PARTIAL | Corrupted and unsupported-schema fixtures fail explicitly; controlled Vendor SDK/CLI version cases remain pending. |

`VERIFIED_BY_TEST` means a synthetic unit/contract test validated AXtory behavior, not that the
installed Vendor implementation was exercised for that scenario.

## Codex design reconnaissance

Official OpenAI documentation verifies that App Server exposes `thread/list` and
`thread/read`; `thread/read` can include turns without resuming or subscribing to the thread.
The current protocol also describes paged stored-turn reads as experimental and exposes thread
source kinds and parent/ancestor filters. OTel and Hooks are disabled by default or require
explicit configuration.

Sources:

- https://developers.openai.com/codex/app-server/
- https://developers.openai.com/codex/config-advanced/
- https://developers.openai.com/codex/hooks/

Codex remains Phase 8. No public abstraction is extracted from these similarities yet. A future
spike must verify whether starting App Server and using `useStateDbOnly` is genuinely read-only,
because the default thread listing may scan JSONL to repair metadata.

## Vendor dependency boundary

The TypeScript Claude Agent SDK repository states that it is subject to Anthropic Commercial
Terms and its package can install platform-specific Claude Code binaries. AXtory therefore
does not declare it as a runtime or peer dependency, does not bundle it, and does not publish
its binary. The spike dynamically loads a separately installed SDK and uses the user's existing
`claude` executable.
