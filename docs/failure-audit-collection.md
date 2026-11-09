# Bounded failure collection

The failure-audit steps of the daily `factory-health` workflow (the former `factory-failure-audit`) read recent local Cezar run handoffs and
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

Collection no longer publishes issues or restarts intake. After collection,
the workflow's separate publisher consumes the versioned artifact and writes
`.factory/failure-audit-publication.json`. It creates one canonical Factory
issue per registered project and normalized signature, appends only new run
evidence, and records created, adopted, existing, skipped, pending,
needs-review, or failed outcomes. Search and post-write confirmation errors fail closed;
ambiguous legacy matches are reported for human review. The publisher never
creates a second issue for the same project and normalized signature set,
closes an issue, or restarts intake. It does not publish when collection status
is `limited`. Recovery remains a separate
explicit workflow action and must stay disabled when coverage is limited.

## Classification

The collector classifies each failure deterministically (`classification` in the artifact):
`factory-defect` (unknown workflow, missing required script, invalid schema, validation or routing
failure, missing managed skill, automation drift), `environment` (timeouts, connection/provider
errors, rate limits, cancellation, gh missing), `project-defect` (test, build, or lint output), or
`unknown`. Only `factory-defect` rows are published as Factory issues; the rest appear in the
publisher receipt message and in `.factory/health-report.json`. An artifact without
`classification` (an older collector) is published as before. No agent classifies failures.

## Agent failure summaries (#103)

`scripts/summarize-failures.ps1 -InputPath <records.json> [-OutputPath <file>] [-MaxChars 4000]` (run from a workflow
`command:` step) turns finding records `{findingId, identifier, message, detailPath, occurrence}` into one entry per
finding ID with `occurrenceCount`, capped identifiers and `detailPaths`. Secrets are `[REDACTED]` using the audit
collector's rules (`scripts/failure-summary-lib.ps1`). Entries are ordered by occurrences descending then finding ID and
cut at entry boundaries to the cap; `omittedEntries` and `omittedOccurrences` keep truncated repeats visible.
