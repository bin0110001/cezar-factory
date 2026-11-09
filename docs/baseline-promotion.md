# Reviewed baseline promotion and the anti-weakening guard

Data lives in `policies/baseline-promotion.json` (version 1): `permittedApprovers`, `mandatoryChecks`,
`thresholdFloors`, `baselinePaths`, `auditLog`, `protectedPaths`. Schemas: `schemas/baseline-promotion.schema.json`,
`schemas/promotion-audit-entry.schema.json`. These are a minimal self-contained format (assumption: the
comparison engine #99 and policies #100 have not landed); they can adopt or replace it later.

## Promotion (`scripts/promote-baseline.ps1`)

Inputs: candidate baseline, baseline path, review record (`approver`, `reviewRef`, `changeAuthor`,
`sourceRun`, written by the workflow from reviewer data, never by the agent). Rejected (exit 1, no baseline
or audit change): no review record, missing reference, approver not permitted, approver equals change author.
On success the baseline is replaced atomically and exactly one JSONL audit entry is appended (approver,
timestamp, source run, review reference, before/after SHA-256, digest of the previous line). If the replace
fails the audit append is rolled back. No network or deployment side effects.

## Guard (`scripts/check-weakening.ps1`)

Runs in the `implement` workflow (`weakening-guard` step, `-BaseRef origin/dev`). The policy is read from the
base, so a change cannot weaken the rules it is judged by. It fails (exit 1, naming the change) on a lowered or
removed threshold, a removed/optional mandatory check or downgraded level, an added suppression/skip/allowlist
entry, an audit log that is not an append-only extension with an intact digest chain, an edit to a protected
path, and a baseline edit without a matching audit entry. Unparseable changed JSON fails closed (exit 2).
Without a policy at base the guard is not enabled for that project and passes. Human maintainers change
protected paths through a reviewed PR outside the agent workflow.
