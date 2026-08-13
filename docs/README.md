# Documentation

Start with what you are trying to do.

## Use AXtory

| Document                       | Contents                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| [CLI reference](cli.md)        | Every command, flag, and limitation, grouped by task             |
| [Privacy](privacy.md)          | What is read, stored, excluded, exported, and how to delete it   |
| [Architecture](architecture.md)| Boundaries, the evidence pipeline, and the trust vocabulary      |

## Understand a vendor's contract

Each research document separates official guarantees from local observation, records what
was verified and how, and states what remains unknown. Official interfaces outrank local
storage details.

| Document                                                        | Covers                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| [Connector contracts](research/connector-contracts.md)          | Claude and Codex: official facts, local observations, gaps    |
| [Additional AI contracts](research/additional-ai-contracts.md)  | Gemini CLI, OpenCode, Cursor Agent, Aider, Kimi Code          |
| [Work-system contracts](research/work-system-contracts.md)      | GitHub, GitLab, Jira, Linear APIs and the minimal contract    |

## Understand a decision

| Document                                                          | Status      |
| ----------------------------------------------------------------- | ----------- |
| [System design](design/system-design.md)                          | `ACCEPTED` for foundation, `PROPOSED` for unimplemented areas |
| [Foundation decisions](design/foundation.md)                      | `ACCEPTED`  |
| [Connector SPI candidate](design/connector-spi-candidate.md)       | `PROPOSED` — not a public API |

## Project history

[`../CHANGELOG.md`](../CHANGELOG.md) is the record of what shipped and when.
[`internal/`](internal/) keeps the planning documents and the dated
requirement-by-requirement audits behind each milestone — useful as evidence, not as a
guide to using AXtory.

## Status vocabulary

Design and research documents carry an explicit status:

- `ACCEPTED` — a current design decision; changing it requires stated rationale and impact analysis.
- `VERIFIED` — confirmed against official documentation or a controlled real execution.
- `VERIFIED_BY_TEST` — confirmed by AXtory's synthetic tests. This is not verification of vendor behavior.
- `PROPOSED` — a candidate before implementation, and not a public contract.
- `NEEDS_SPIKE` — not settled until the real interface is verified.
- `DEFERRED` — outside the current phase.

When a document and the code disagree, do not quietly rationalize it. Check the actual
behavior, then record the conflict, its effect on core principles, the minimal fix, and the
impact on other connectors before updating the document.

## Language

User-facing documents (CLI reference, privacy, architecture) are written in English.
The planning documents under [`internal/`](internal/) and parts of the design and research
documents are in Korean, which is the project's working baseline.
