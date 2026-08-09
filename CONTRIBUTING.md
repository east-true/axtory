# Contributing to AXtory

Thank you for helping build evidence-aware, local-first AI/AX analytics.

## Development

AXtory requires Node.js 24 or later.

```sh
npm ci
npm test
```

Core tests must pass without a Claude or Codex SDK. Vendor SDKs are optional local tools for
controlled contract spikes and must not be added to the lockfile or distributed package.

## Design rules

- Preserve RawObservation, NormalizedObservation, and AnalysisRecord boundaries.
- Never convert missing values to zero.
- Keep derivation, assertion, provenance, verification, and availability as separate concepts.
- Do not add an undocumented Claude/Codex storage parser or silent fallback.
- Do not publish a Connector SPI before Claude and Codex implementations prove commonality.
- Changes to Vendor configuration require capability, plan, consent, backup, verification, and rollback.

## Fixtures and privacy

Only synthetic fixtures are accepted. A fixture must not contain a real name, username, company,
path, repository, source fragment, prompt, session identifier, API key, token, or personal data.
Do not sanitize a real session and commit it; construct a synthetic case instead.

## Pull requests

Explain the observed contract or requirement, the change, its evidence, and its limitations.
Include deterministic tests and update the relevant planning, architecture, or research document.
Do not claim a Vendor behavior is verified when only a mock or synthetic fixture was tested.
