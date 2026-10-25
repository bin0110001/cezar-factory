# Bounded failure collection

The `factory-failure-audit` workflow reads recent local Cezar run handoffs and
event tails and writes `.factory/failure-audit-input.json` in its worktree.
The collector is read-only apart from that artifact. Cezar check steps inherit
the service environment, which does not include a per-project ID. When a
`CEZAR_PROJECT_ID` override is absent, the collector takes the Cezar project
slug from the current isolated worktree's registered project root. Its API
URL defaults to Cezar's loopback endpoint (`http://127.0.0.1:4321`) and may be
overridden with `CEZAR_API_URL`. It never requests the bulk `/runs` API.

Default limits are a 24-hour window, 20 selected runs, 200 candidate
handoffs, 64 KiB from each handoff and event source, 200 event lines, eight
failure summaries, and 12,000 evidence characters. Candidate discovery is
also bounded: exhausting it sets `status: limited` because the collector can
no longer claim complete recency. Oversized and missing sources are likewise
reported as limitations. Evidence is redacted before the version 1 artifact
is serialized. The schema is `schemas/failure-audit-result.schema.json`.

Collection no longer publishes issues or restarts intake. Those are separate
operations and cannot be inferred from a `ready` collection receipt. The
idempotent publisher is tracked in #31; until it is implemented, the daily
workflow only collects evidence. Recovery must be an explicit later command
and must stay disabled when coverage is limited.
