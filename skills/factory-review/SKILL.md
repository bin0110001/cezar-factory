<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-review/SKILL.md
-->
# Factory Review Skill

## Responsibilities

- Independently review the implementation.
- Treat this as technical review, not a request for user approval. A passing
  review proceeds to the normal auto-merge handoff without waiting for the user.
- Compare changes against issue acceptance criteria.
- Check for missed edge cases.
- Check architecture/conventions.
- Check tests for meaningful coverage.
- Check unrelated changes.
- Check backward compatibility where relevant.
- Produce actionable findings.
- Route to:
  - `factory:changes-requested`
  - `factory:human-review` only when review exposes a major architectural decision

## Note

Prefer a different agent/context from implementation.

## Detailed Guidance

### 1. Independently Review the Implementation

- Review the PR diff without the context of the implementation agent's reasoning.
- Use a fresh perspective to identify issues the implementer may have missed.
- If possible, use a different agent or model for the review.

### 2. Compare Changes Against Acceptance Criteria

- Go through each acceptance criterion from the issue plan.
- Verify that the implementation satisfies each criterion.
- Note any criteria that are not fully met.

### 3. Check for Missed Edge Cases

- Consider invalid inputs, null values, and unexpected states.
- Review error handling and failure modes.
- Check boundary conditions and limits.

### 4. Check Architecture/Conventions

- Ensure the change follows the project's architectural patterns.
- Verify that new code adheres to naming, structure, and organization conventions.
- Look for violations of separation of concerns or other architectural principles.

### 5. Check Tests for Meaningful Coverage

- Review the tests added or modified.
- Ensure tests cover the acceptance criteria and edge cases.
- Check that tests are not trivial or merely exercising code without assertions.
- Verify that tests would catch regressions if the implementation changed.

### 6. Check Unrelated Changes

- Review the PR diff for any changes unrelated to the issue.
- Flag any accidental changes, formatting adjustments, or scope creep.
- The PR should contain only changes directly related to the issue.

### 7. Check Backward Compatibility

- If the change affects public APIs or interfaces, verify backward compatibility.
- Note any breaking changes that require migration or deprecation.
- For data model changes, check that existing data remains valid.

### 8. Produce Actionable Findings

- Categorize findings as blocking or non-blocking.
- Each finding should include:
  - A clear description of the issue.
  - The file and line number where it occurs.
  - A specific recommendation for how to fix it.
- Avoid vague or subjective criticism; focus on verifiable issues.

### 9. Route the Issue

- Set `approvalChangeRequestStatus` to `approval` only when no blocking findings remain; `change-request` requires `blockingFindings`.
- Do **not** edit `factory:*` labels. Write the structured result to `.factory/review-result.json` (create the directory), including the issue number, exact PR URL, reviewed 40-character head SHA, and your reviewer identity (`runner/model`). The workflow validates it and routes the issue state.
- The workflow posts your findings to the issue and routes approved, validated
  PRs to the bounded auto-merge path; rejected PRs go to
  `factory:changes-requested`. Never approve a PR with unresolved blocking
  findings or failed validation.

## Risk-Based Routing

Include the exact PR URL, `reviewedHeadSha`, and `reviewerIdentity` in every
result. Approved work at every risk level is eligible for the bounded
auto-merge path only after live head, validation receipts, effective GitHub
rules, status checks, approval, and review-thread state pass.
Risk level alone never requires user plan approval. Independent review remains
required; ask the user only when an unresolved major architectural decision
materially changes compatibility, ownership, or the system contract.

- **Low risk** (docs, tests, minor UI, small bug fixes): Approved review may request auto-merge to `dev`.
- **Medium risk** (features, refactoring, networking, persistence): Approved review may request auto-merge to `dev`.
- **High risk** (auth, security, data migration, billing, architecture): Requires full validation and independent review before auto-merge to `dev`; user input is required only for an unresolved major architectural decision.

## Output Format

Produce a review result conforming to `review-result.schema.json`:

```json
{
  "issue": 272,
  "approvalChangeRequestStatus": "approval",
  "blockingFindings": "",
  "nonBlockingFindings": "",
  "acceptanceCriteriaVerification": "Each acceptance criterion is met.",
  "testAdequacy": "Focused regression and required validation passed.",
  "riskObservations": "No unresolved risks found.",
  "pr": "https://github.com/example/project/pull/12",
  "reviewedHeadSha": "0123456789abcdef0123456789abcdef01234567",
  "reviewerIdentity": "claude/sonnet"
}
```

For `change-request`, replace the verdict and name each blocking finding in
`blockingFindings`. Keep `pr` pointed at the reviewed PR.
