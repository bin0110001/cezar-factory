# Factory review skill

Independently review the pull request associated with the single issue selected by the Cezar workflow. Return evidence-backed findings for workflow-owned validation and routing.

## Inputs and prerequisites

- Use the selected issue, its approved plan and acceptance criteria, the linked pull request, its current diff/head, and the verification evidence supplied by this workflow run.
- Review the current PR head, not a remembered or stale revision. Include its exact URL and 40-character head SHA in the result.
- Use a separate agent session from implementation where configured. Review the change on its merits; do not rely on the implementer's summary as proof.
- If the task does not identify one unambiguous issue and PR, or the current head and required evidence cannot be established, report the blocker in findings and do not approve.

## Required judgment

- Compare every acceptance criterion with code and test evidence. Inspect the diff for correctness, missed edge cases, architecture/convention fit, meaningful test coverage, unrelated changes, and relevant compatibility risks.
- Record blocking and non-blocking findings separately. Each finding names a verifiable issue, its file/location, and a concrete fix.
- Choose `approval` only when no blocking findings remain and the current diff meets the plan. Choose `change-request` when blocking findings remain.
- Request human review for an unresolved major architectural decision. High-risk changes also require the separate human plan-approval gate before auto-merge can be requested.
- Identify the active reviewer as `runner/model` only when that identity is available from the current runtime; never invent it.

## Output contract

Return one JSON object with `approvalChangeRequestStatus`, `blockingFindings`, `nonBlockingFindings`, `acceptanceCriteriaVerification`, `testAdequacy`, `riskObservations`, `pr`, `reviewedHeadSha`, and `reviewerIdentity`. The workflow validator binds the selected issue identity before downstream steps consume the result. Keep evidence concise and specific. `change-request` requires at least one blocking finding.

Example model output:

```json
{
  "approvalChangeRequestStatus": "approval",
  "blockingFindings": "",
  "nonBlockingFindings": "Consider adding a note about the supported timeout range.",
  "acceptanceCriteriaVerification": "Each criterion is met by the current diff and corresponding behavior.",
  "testAdequacy": "Required verification passed and covers the changed behavior.",
  "riskObservations": "No unresolved compatibility or safety risk found.",
  "pr": "https://github.com/example/project/pull/12",
  "reviewedHeadSha": "0123456789abcdef0123456789abcdef01234567",
  "reviewerIdentity": "claude/sonnet"
}
```

## Boundaries

Do not modify code, run commands or Factory scripts, write workflow result files, post comments, change labels, merge, or request auto-merge. Return only the review object. The workflow validates the result, evaluates merge gates, posts findings, and routes the issue.
