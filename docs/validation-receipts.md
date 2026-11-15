# Validation results and receipts

`implementation-result.json` is an agent handoff. Its `testResult` and
`acceptanceCriteriaStatus` fields describe the implementation and are checked
for internal consistency by `scripts/validate-result.ps1`. A successful result
requires a passed test outcome, named tests and changed files, met acceptance
criteria, and a GitHub pull request URL. A failure result may describe failed
or unrun tests. These legacy strings remain readable but are not proof that
the current PR head passed a workflow test.

`schemas/validation-receipt.schema.json` defines version 1 of the separate
workflow evidence record. The workflow command that executes a configured
validation stage writes it under the current worktree's
`.factory/artifacts/validation/` directory. It binds the issue, repository,
PR, 40-character head SHA, stage (`changed`, `full`, or `verify`), normalized
status, child exit code, artifact paths, and clean-worktree flag. Consumers must compare the
receipt's repository, PR, and head SHA with the current GitHub PR and require
the applicable stages to have `status: passed` and `exitCode: 0`. A changed-stage
`status: warning` is accepted only when every warning names an issue in the same
project repository; full and verify stages remain strict. The warning and issue
links stay in the receipt. In `.ai/factory/test-ownership.json`, a focused check
may set `knownIssue` to the full GitHub URL for the issue tracking that failure.
A failed check with this field becomes an issue-linked warning; a check without
it still fails the implementation step. Keep the issue description aligned with
the failure mode covered by that check.

A matching version or an agent-written result alone does not qualify as merge evidence.

The configured project runner and receipt producer are provided by #19. The
current-head merge gate that consumes the receipts is tracked in #27. Until
that gate is in place, the review/merge handoff must stay fail-closed rather
than promoting a legacy result to trusted evidence.
