# Bounded failure collection

The `factory-failure-audit` workflow reads recent local Cezar run handoffs and
event tails and writes `.factory/failure-audit-input.json` in its worktree.
The collector is read-only apart from that artifact. It requires the
registered `CEZAR_PROJECT_ID` and `CEZAR_API_URL`; it never guesses project
identity from a folder name or requests the bulk `/runs` API.

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
