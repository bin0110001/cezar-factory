<!--
managed-by: cezar-factory
factory-version: 0.1.0
source: skills/factory-fix/SKILL.md
-->
# Factory Fix Skill

## Responsibilities

- Read review findings.
- Address only valid findings.
- Avoid unrelated cleanup.
- Update tests as needed.
- Re-run validation.
- Return to review.

## Detailed Guidance

### 1. Read Review Findings

- Review the findings posted by the review skill or human reviewer.
- Categorize each finding as blocking or non-blocking.
- Understand the root cause of each finding before attempting a fix.

### 2. Address Only Valid Findings

- Fix each blocking finding that is within the scope of the issue.
- If a finding is invalid or based on a misunderstanding, document your reasoning.
- Do not fix findings that are out of scope or require separate issues.

### 3. Avoid Unrelated Cleanup

- Make only the changes necessary to address the findings.
- Do not refactor, reformat, or clean up unrelated code.
- If a fix reveals an opportunity for improvement, note it as a follow-up suggestion.

### 4. Update Tests as Needed

- If a fix changes behavior, update existing tests to reflect the new behavior.
- Add tests that specifically verify the fix addresses the review finding.
- Ensure tests continue to cover the acceptance criteria.

### 5. Re-run Validation

- Execute the project's `test-changed.ps1` script to validate the fixes.
- If full validation is required, run `test-full.ps1` or `verify.ps1`.
- Ensure all tests pass before returning to review.

### 6. Return to Review

- Update the PR with the fixes.
- Do **not** edit `factory:*` labels. Write the structured result to `.factory/implement-result.json` (create the directory), including the issue number in `issue` and the PR URL in `pr`. The workflow validates it and routes the issue state.
- Fixes are reported with the implementation result schema; the workflow returns the issue to `factory:review`.

## Retry Limits

- Maximum review/fix rounds: 2 (see `policies/retry.yaml`).
- After the limit is reached, escalate to investigation.

## Output Format

Produce an implementation result conforming to `implementation-result.schema.json`:

```json
{
  "status": "success | failure",
  "summary": "Description of fixes applied",
  "filesChanged": ["path/to/file1"],
  "testsRun": ["test name"],
  "testResult": "passed | failed",
  "acceptanceCriteriaStatus": "All criteria met | Partially met",
  "knownConcerns": "Any remaining concerns",
  "followUpSuggestions": "Recommended follow-up work",
  "durableKnowledgeCandidates": "Reusable knowledge discovered"
}
```