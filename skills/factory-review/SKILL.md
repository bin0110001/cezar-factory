<!--
managed-by: cezar-factory
factory-version: 0.1.0
source: skills/factory-review/SKILL.md
-->
# Factory Review Skill

## Responsibilities

- Independently review the implementation.
- Compare changes against issue acceptance criteria.
- Check for missed edge cases.
- Check architecture/conventions.
- Check tests for meaningful coverage.
- Check unrelated changes.
- Check backward compatibility where relevant.
- Produce actionable findings.
- Route to:
  - `factory:changes-requested`
  - `factory:human-review`

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

- If all blocking findings are resolved and acceptance criteria are met:
  - Set `factory:human-review` (for high-risk changes) or proceed to `factory:done` (for low-risk, if auto-merge is enabled).
- If there are blocking findings:
  - Set `factory:changes-requested`.
  - Post the findings as a comment on the PR.

## Risk-Based Routing

- **Low risk** (docs, tests, minor UI, small bug fixes): Review may route directly to human-review or done.
- **Medium risk** (features, refactoring, networking, persistence): Must route to human-review after approval.
- **High risk** (auth, security, data migration, billing, architecture): Must route to human-review regardless of review outcome.

## Output Format

Produce a review result conforming to `review-result.schema.json`:

```json
{
  "approvalChangeRequestStatus": "approval | change-request",
  "blockingFindings": "Description of blocking issues (empty if none)",
  "nonBlockingFindings": "Description of non-blocking issues (empty if none)",
  "acceptanceCriteriaVerification": "Verification of each acceptance criterion",
  "testAdequacy": "Assessment of test coverage and quality",
  "riskObservations": "Any risk-related observations"
}
```