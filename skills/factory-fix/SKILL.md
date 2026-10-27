<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-fix/SKILL.md
-->
# Factory Fix Skill

## Contract

- **Purpose:** Resolve the current PR's actionable review findings and return
  the change to independent review.
- **Prerequisites and bounded input:** Use the latest review findings, the
  existing PR, and the issue plan already prepared by the workflow. Work only
  on findings within that issue's acceptance criteria and non-goals.
- **Required judgment:** Verify each finding against the current diff and
  project guidance. Fix valid blocking findings; explain invalid or out-of-scope
  findings without broadening the change.
- **Output:** Return one structured implementation result for the existing PR,
  including changed files, validation, acceptance status, concerns, and
  follow-ups.
- **Escalation:** Stop and report an unresolved compatibility, ownership, or
  system-contract decision. After the configured two fix rounds, stop editing
  and let the workflow route the issue to investigation.
- **Forbidden effects:** Do not select other issues, create replacement tasks,
  edit Factory lifecycle labels, write workflow artifacts, or run Factory
  scripts. Workflow command steps own validation and result routing.

## Detailed Guidance

### 1. Read Review Findings

- Review the latest blocking findings posted by the review skill or human reviewer.
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

- Run the project's own test commands while fixing. The workflow runs `test-changed.ps1` after you finish; do not run Factory scripts yourself.
- Ensure all tests pass before returning to review.

### 6. Return to Review

- Update the PR with the fixes.
- Do **not** edit `factory:*` labels or write `.factory/implement-result.json`. Return the structured result object with the existing PR URL in `pr`; the workflow materializes the result and binds issue identity from the selected task.
- Fixes are reported with the implementation result schema; the workflow returns the issue to `factory:review`.

## Retry Limits

- Maximum review/fix rounds: 2 (see `policies/retry.yaml`).
- After the limit is reached, escalate to investigation.

## Output Format

Produce an implementation result conforming to `implementation-result.schema.json`:

```json
{
  "status": "success",
  "summary": "Fixed the blocking review finding.",
  "filesChanged": ["src/example.ps1"],
  "testsRun": ["focused regression test"],
  "testResult": "passed",
  "acceptanceCriteriaStatus": "All criteria met",
  "documentationUpdated": false,
  "knownConcerns": "",
  "followUpSuggestions": "",
  "durableKnowledgeCandidates": "",
  "pr": "https://github.com/example/project/pull/12"
}
```

The example shows a successful fix. Use `status: failure` and describe the
blocker when the review finding cannot be resolved; a successful result needs
the existing PR URL. Set `documentationUpdated` to `false` after confirming
that no documentation change is needed.
