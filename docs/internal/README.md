# Internal documents

Project-management records, kept as evidence rather than as guidance. Nothing here is
needed to use AXtory — start at [`../README.md`](../README.md) for that.

These documents are dated snapshots. Where they disagree with the code, the code is
current; where they disagree with [`../design/`](../design/), the design documents are the
baseline. They are written in Korean.

| Document                                          | Contents                                                     |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [Product plan](product-plan.md)                   | Problem, user value, scope, product principles, success criteria |
| [Delivery plan](delivery-plan.md)                 | Per-phase goals, implementation targets, tests, exit criteria |
| [Implementation plan](implementation-plan.md)     | Initial repository assessment, preserved for the record       |
| [Audits](audits/)                                 | Requirement-by-requirement completion evidence per milestone  |

The audits are the source material behind [`../../CHANGELOG.md`](../../CHANGELOG.md). Read
the changelog for what shipped; read an audit when you need the evidence for a specific
requirement, the verification that was actually run, or the limitations that were recorded
at the time.

| Audit                                                            | Milestone                                    |
| ---------------------------------------------------------------- | -------------------------------------------- |
| [Initial implementation](audits/initial-implementation-audit.md) | Foundation and Claude Code history           |
| [Second implementation](audits/second-implementation-audit.md)   | Semantic analysis, Local Git, Hook and OTel  |
| [Phase 8](audits/phase8-codex-audit.md)                          | Codex                                        |
| [Phase 9](audits/phase9-work-systems-audit.md)                   | Work systems                                 |
| [Phase 10](audits/phase10-additional-ai-audit.md)                | Additional AI sources                        |
| [Phase 10.5](audits/phase10-5-usage-analytics-audit.md)          | Usage analytics                              |
