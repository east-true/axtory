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
  carries. Both are path- and name-bearing, so AXtory reads them only as digests, under the same rule
  the Local Git collector already follows. This is what `--workspace-dir` compares against.

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
  does not currently perform.

### Does shared message identity actually separate forks?

The controlled run showed a fork shares `uuid` values. It did not show whether anything *else* does,
which is what decides if the signal can carry a relation. A structural read of the retained local
history measured that directly, on identity only, with no content compared.

The history held 85 sessions and 14744 messages at the time of this read, all of which carried a
`uuid`. Note that an earlier read recorded 265 sessions and 24917 messages; the retained history has
since shrunk, so these two measurements are separate snapshots rather than a correction.

- 14576 of the uuids were unique to one session. Exactly 168 appeared in more than one, and those
  168 produced exactly **one** session pair out of the 3570 possible. Message identity is therefore
  effectively global, and sharing it is rare enough to mean something.
- That pair has the fork shape exactly. The shorter session's 168 uuids are a **contiguous prefix
  from index 0** of the longer session's 618, in the same order. Same `cwd`, same `gitBranch`.
- **Zero** pairs shared uuids without one being a prefix of the other. The ambiguous case that would
  force a guess did not occur.
- Direction is recoverable and over-determined. The session that contains the other as a prefix is
  the child, and it was created about 22 hours later. The two signals agreed.

So the rule is sound on real data: no false positive appeared, and the one true case is unambiguous
in both existence and direction.

### Decision: emit `FORKED_FROM` for Claude, as an INFERRED relation

Recorded here so it is not re-litigated. AXtory emits the relation, but not the way Codex does.
Implemented as `analyze-fork-lineage`.

- **Derivation is `INFERRED`, not `OBSERVED`.** Codex reads a declared `forkedFromId`, so its
  relation is a Vendor claim. Claude declares nothing; the link survives only because the fork
  implementation copies messages without reassigning their ids. The identity compared is Vendor
  data, but the relation is read out of an implementation detail, and the Derivation vocabulary
  exists to mark exactly that difference. Presenting the two as the same kind of fact would overstate
  the Claude one.
- **It belongs in an analysis pass, not the normalizer.** The comparison is between sessions and the
  normalizer sees one session at a time. Putting it in normalization would either force the
  normalizer to hold a collection-wide index or push a false relation into a canonical observation.
- **The predicate is exact prefix containment, not overlap.** Requiring the shared uuids to form a
  contiguous prefix from index 0 of the longer session, and requiring the prefix holder to be the
  older session, turns every ambiguous case into no relation instead of a guess. Both conditions
  held in the observed case and neither is expensive to check.
- **Silent breakage is the accepted risk.** If Claude ever reassigns ids on fork, the signal
  disappears and the relation stops being emitted. That is a false negative, which the coverage
  vocabulary can express, rather than a false positive, which it cannot repair.
- Only identity digests are compared, so the pass stays content-free like the rest of the pipeline.

The content fallback was closed as part of implementing this. The Claude normalizer derives a
message identity from the Vendor `uuid`, falling back to a hash of the message index and content
when the key is absent. Two sessions that merely opened with the same prompt would then share a
fallback identity, which is precisely the manufactured lineage the earlier history read warned
about. The normalizer now records `sourceMessageIdentityFrom`, and a session holding any
content-derived identity is excluded from the pass rather than compared. Revisions collected before
that field existed carry no marker and are treated as Vendor-assigned, which matches the 14744
messages measured to carry a `uuid` without exception. Normalizer version moves to
`claude-official-history/3`.

Run against a real 86-session collection, the pass reproduced the probe exactly: 1 candidate pair,
1 relation, 0 ambiguous, 0 without a direction, with a 168-message shared opening between a
168-message parent and a 618-message child created about 22 hours later.

### Controlled real active session

Real bounded `claude -p` runs, read through the official API while they were still producing
output. This is the Claude counterpart of the Codex unsettled-turn question, and it lands on the
opposite answer.

**A mid-turn view is genuinely incomplete and nothing in it says so.** A session read while its
turn was running returned exactly one message, the user's. The same session after the turn settled
returned three: user, assistant, assistant. No message in either view carried any key beyond
`type`, `uuid`, `session_id`, `message`, `timestamp`, `parent_tool_use_id`, and `parent_agent_id`,
so no field marks the turn as unfinished.

**The mid-turn shape is identical to an abandoned opening.** A lone user message with no assistant
reply is exactly what 152 of the 265 sessions in the earlier history read looked like. Those are
real, finished-with sessions. A running turn and an abandoned opening are therefore the same view,
and no in-view predicate can separate them. Codex settles the same question from inside its
snapshot because a turn carries `completedAt`; Claude exposes no equivalent, so
`PARTIAL_UNSETTLED_TURN` has no Claude analogue to read.

**The existing change signal is real but low-sensitivity, and this is measured rather than
assumed.** The collector compares the `lastModified` in the session list against a `getSessionInfo`
taken after that session's messages are read. `lastModified` does advance while a session is live,
so the signal is not dead: a bounded run showed three distinct values across about a minute. It
nevertheless did not fire in any real attempt — nine full collections run against live sessions
reported `sourceChangedViews: 0`, as did 67 tighter list/read/re-read cycles. Two measurements
explain why:

- The live session is always first in the walk. `listSessions` returns most-recently-modified
  first, and across every poll of a 94-session list the running session sat at index 0. It is
  therefore the session with the *smallest* possible gap between the list snapshot and its own
  re-read, which is the opposite of what catching a concurrent write would need.
- A bounded run writes about twice, not continuously. Two writes were observed in one run and three
  distinct `lastModified` values in another, clustered rather than spread. A write has to land
  inside a window of milliseconds to be seen.

**Consequence, stated plainly.** AXtory can record a Claude session mid-turn, label the view
`COMPLETE_FOR_RETURNED_VIEW`, and be wrong about the conversation being finished, with no available
signal to prevent it. Marking every Claude session `UNKNOWN` would trade a rare wrong claim for a
constant useless one, and inventing a recency threshold would be a guess of exactly the kind the
coverage vocabulary exists to avoid. The honest position is that the limitation is a Vendor gap,
recorded here, and that a later collection supersedes the partial one with a complete revision.

### Controlled worktree session

A fourth run created a session inside a real `git worktree` of this repository.

- The session is returned by `listSessions` and carries the worktree's own `cwd` and its branch in
  `gitBranch`. Nothing relates it to a session in the main working tree, so a worktree is workspace
  context and not a lineage relation.
- `includeWorktrees` did not gate the result: the session appeared with the flag true, false, and
  unset, on an 80-session page. AXtory forwards `true`, which remains the safe choice, but this
  probe gives no evidence that the flag excludes anything.
- `cwd` alone cannot identify a worktree. Across the 265-session history the same `cwd` hosts many
  branches — one directory accounts for 31 distinct `(cwd, gitBranch)` pairs across 12 directories —
  because branch switching and worktrees both surface as a directory plus a branch name. Separating
  them would need repository identity, which the session view does not expose.
- Both fields are path- and name-bearing, so capturing them at all would require hashing under the
  rule the Local Git collector already follows.

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
| Active-session snapshot consistency | VERIFIED/NEGATIVE | Settled against real live sessions. A mid-turn view returned 1 message where the settled one returned 3, and no field marks the turn unfinished; the shape is identical to the abandoned openings that make up most of the history, so no in-view predicate can separate them and Codex's `completedAt` test has no Claude analogue. The `lastModified` comparison is real — the value does advance while a session is live — but did not fire in 9 full collections or 67 tighter cycles, because the live session always sorts to index 0 (smallest possible window) and a bounded run writes only about twice. A mid-turn view can therefore be labelled complete; a later collection supersedes it. |
| Resume boundaries within one session | NOT_SUPPORTED | Keep SessionRun separate; return UNKNOWN. |
| Fork lineage in history reads | VERIFIED | A controlled `--fork-session` creates a new session that declares no parent in any field, but copies the parent's messages keeping their Vendor-assigned `uuid` while rewriting `session_id` to the child. Lineage is therefore derivable from shared message identity, not from content resemblance. A read of 85 real sessions found one shared-uuid pair out of 3570, with exact prefix shape and no ambiguous case, so `FORKED_FROM` is emitted as an `INFERRED` relation by the `analyze-fork-lineage` pass. |
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
| Message order | VERIFIED_BY_TEST | Synthetic contract tests establish that pagination preserves the source order, that an overlapping page is deduplicated while coverage drops to `PARTIAL_PAGINATION`, and that a max-page guard never claims completeness. Whether the Vendor guarantees a stable order is not inferred from this. |
| ToolUse/ToolResult presence | VERIFIED | Only allowlisted type labels are retained; payloads are excluded. |
| Resume and fork lineage | VERIFIED | Controlled sessions separated the two. Resume keeps the same `sessionId` and grows it, so there is nothing to relate. Fork mints a new `sessionId` whose messages repeat the parent's `uuid` values, which is Vendor-assigned identity rather than duplicate content. |
| Long session | VERIFIED | Returned 200-message views are explicitly partial. |
| Compaction | PARTIAL_CAPABILITY | Synthetic contract preserves `PARTIAL_COMPACTION`; real system-message semantics are not inferred. |
| Active session | VERIFIED_BY_TEST/NEGATIVE | Post-read metadata changes produce `PARTIAL_SOURCE_CHANGED` in synthetic tests. Real live sessions were then collected: the signal never fired, and the Vendor exposes no marker that would let a mid-turn view be recognized at all. |
| Git worktree | VERIFIED | A controlled session inside a real worktree is returned and carries that worktree's own `cwd` and `gitBranch`. It is workspace context rather than lineage: no key relates it to a session in the main working tree. AXtory now reads both fields, but only as digests and only as workspace context, so a worktree still yields no relation. |
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

### Controlled resume, interruption, and concurrent read

Four bounded `codex exec` runs on CLI 0.147.0, collected into isolated data directories.

- `codex exec resume <id>` returns the **same** `thread_id` and appends to it. Resume extends a
  thread rather than forking it, so it produces no relation, and no `relation:` observation appeared
  in either collection.
- Killing an `exec` mid-turn leaves a thread whose `turn.completed` never arrived. App Server does
  not mark it: the collector recorded `COMPLETE_FOR_RETURNED_VIEW` and counted zero active views.
- Collecting **while** an `exec` was still producing output found the running thread and likewise
  recorded it as a complete view with two messages and `activeViews: 0`.
- `thread.status.type` was `notLoaded` on all 29 collected views across both collections, including
  the thread that was mid-turn at snapshot time. The value `active` that the collector and the spike
  test for never appeared, and the `listed.updatedAt !== detail.updatedAt` fallback did not fire
  either.
- The read path explains why. AXtory backs the state database up into a private `CODEX_HOME`,
  spawns a **fresh** App Server against that copy, and asks for `useStateDbOnly: true`. An `active`
  status describes a thread live inside a running App Server, and this one is running nothing over a
  frozen copy, so every thread is reported `notLoaded` by construction. The isolation that makes the
  read safe is the same thing that hides liveness.
- The `updatedAt` fallback is defeated for the same reason: list and detail both come from one
  consistent backup, so they agree no matter what the live database is doing.
- The evidence needed is already inside the snapshot. Every observed turn carries a completion time,
  and both the killed thread and the one read mid-run ended with `status: "interrupted"` and
  `completedAt: null`, while settled turns showed `completed` or `failed` with a timestamp. Coverage
  is now decided on `completedAt === null` rather than on a live status, so no second read, no
  timing window, and no access to the live database is required.
- The predicate is `completedAt`, not the status vocabulary, so a new status value cannot silently
  reintroduce a false completeness claim.
- An interrupted turn and a still-running turn remain indistinguishable through an isolated read.
  That is the correct outcome: both are views of a turn that never finished, and the collector's job
  is to stop claiming the view is complete rather than to guess which case it saw.
- Whether an App Server daemon reading live state reports `active` remains untested. It would not
  change the collector, which reads a snapshot on purpose.

### Workspace context in the thread view

A structural read of 40 real threads out of 193 listed, on CLI 0.147.0, settled how App Server
reports the directory a thread ran in. This is the Codex counterpart of the Claude session's `cwd`
and `gitBranch`.

- `cwd` was present and non-empty on all 40, absolute on all 40, and already equal to its own
  `resolve()` on all 40, with no trailing slash. The list summary and the detail view agreed on it
  for every thread. Hashing it therefore produces the same digest a report computes from a directory
  the caller names, which is what lets one `--workspace-dir` select Claude and Codex sessions
  together. 7 distinct directories appeared.
- `gitInfo` is null on 24 of the 40. When present it exposes `sha`, `branch`, and `originUrl`, and
  `branch` was itself null on 8 of those 16. A branch is therefore recorded by only 8 of 40 threads,
  and its absence is a thread that did not run in a Git working tree rather than a collection gap.
  Distinct-branch counts consequently need their own denominator instead of the workspace one.
- `originUrl` is repository identity, which the Claude session view does not expose. It would
  separate a worktree from a branch switch — the distinction the Claude read could not make.
  **Decided: not collected.** The Claude session view has no counterpart, so collecting it would make
  the two sources asymmetric, and unlike a local path it names a remote repository, which is a weaker
  case for retention even hashed. No product requirement asks for the distinction it would enable.
- Only the digests of `cwd` and `gitInfo.branch` are kept, under the rule the Claude connector and
  the Local Git collector already follow. `sha` and `originUrl` are not read. Confirmed on a real
  50-thread collection: 7 distinct workspaces, 3 distinct branches, 42 threads without one, and no
  path in the exported report.
- Normalizer version moves to `codex-app-server/2`.

### Version compatibility

Codex 0.146.1 was installed into a throwaway prefix and driven through the same collector, with
discovery pointed at it by `env` so the user's global 0.147.0 was never replaced. The two were then
compared call by call.

- `initialize`, `thread/list`, and `thread/read` all exist on both, the accepted `sourceKinds`
  vocabulary is identical, and the `thread/list` envelope is the same `data`/`nextCursor`/
  `backwardsCursor` shape. A listed thread carries 26 keys on 0.147.0 against 25 on 0.146.1, an
  additive difference that changes nothing AXtory reads.
- The break is `thread/read` with `includeTurns: true`, which AXtory always sends. On 0.146.1, 5 of
  40 real threads were refused with "paginated threads do not support
  `thread/read(includeTurns=true)`". The same 40 all read on 0.147.0. Support for reading a
  paginated thread whole therefore arrived in 0.147.0, and AXtory depends on it because it
  deliberately avoids the experimental paged turn API.
- **0.147.0 is a floor, not a preference.** Below it, any thread large enough to be paginated
  cannot be collected.
- The failure is also all-or-nothing: one unreadable thread aborts the run, so the 35 readable ones
  are lost rather than reported as partial coverage. Treating an unreadable thread as explicit
  partial coverage would fit the coverage vocabulary better and is not implemented.
- The client used to raise a bare `-32600`, which named nothing. It now carries the server's own
  message, which is what identified this in the first place.

### Contract status

| Contract | Current status | Handling |
| --- | --- | --- |
| App Server lifecycle | VERIFIED | Isolated state snapshot is mandatory; direct original-home startup is rejected by design. |
| Version compatibility | VERIFIED | 0.147.0 is the floor. 0.146.1 shares the methods, source-kind vocabulary, and response shape, but refuses `thread/read(includeTurns=true)` for paginated threads (5 of 40 real threads), which AXtory always requests. Untested above 0.147.0. |
| `thread/list` cursor pagination | VERIFIED_BY_TEST/PARTIAL | Cursor advance, repeat detection, max-page bound, duplicate handling, archive split tested. |
| source kind coverage | VERIFIED | Current generated schema kinds are explicit; future unknown kinds require compatibility review. |
| `useStateDbOnly` | VERIFIED | Forced on every list call; metadata repair scan is never requested. |
| `thread/read` returned turns | VERIFIED | Installed App Server returned full turns without resume/subscription. |
| active thread consistency | VERIFIED | `status` and `updatedAt` cannot signal liveness through an isolated read, so coverage is decided on turn completion instead: a thread holding a turn with `completedAt: null` is `PARTIAL_UNSETTLED_TURN`. Confirmed against a real interrupted thread and a real mid-run one. |
| subagent lineage | VERIFIED | A bounded read of 189 threads found 126 spawned subagents. All declare `source.subAgent.thread_spawn.parent_thread_id` and none populate the top-level `parentThreadId`. AXtory reads the nested field and hashes it. |
| fork vs spawn | VERIFIED | A spawned subagent repeats its parent in `forkedFromId`, so App Server implements spawning as a fork. Only `SUBAGENT_OF` is emitted for that link; a `forkedFromId` pointing elsewhere still yields `FORKED_FROM`. A controlled `exec resume` is not a fork: it keeps the same thread id and emits no relation. |
| compaction | VERIFIED/PARTIAL | Event type observed; returned view is marked partial, semantics are not reconstructed. |
| workspace context | VERIFIED | `cwd` is present, absolute, and already normalized on all 40 inspected threads, and matches between list and detail, so its digest is comparable with the Claude connector's. `gitInfo.branch` is recorded by 8 of 40; an absent branch is a thread outside a Git working tree. |
| repository identity | NOT_COLLECTED | `gitInfo.originUrl` would separate a worktree from a branch switch. Decided against: Claude exposes no counterpart, it names a remote repository rather than a local path, and no requirement needs the distinction. |
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
