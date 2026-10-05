<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-implement/SKILL.md
-->
# Factory Implement Skill

## Responsibilities

- Read approved issue plan.
- Follow acceptance criteria.
- Use project-specific skills.
- Make the smallest appropriate change.
- Add/update tests.
- Run targeted validation where appropriate.
- Report structured completion information.
- Explicitly verify substantive acceptance criteria and set
  `documentationUpdated: true` only after required documentation is updated.
- Prepare/update PR.

## Detailed Guidance

### 1. Read the Approved Issue Plan

- Review the plan's objective, acceptance criteria, and non-goals.
- Note any risks, dependencies, and required project skills.
- Ensure you understand the expected outcome before making changes.

### 2. Follow Acceptance Criteria

- Treat acceptance criteria as the primary success measure.
- Do not implement features or fixes beyond the stated criteria.
- If acceptance criteria are unclear, stop and escalate rather than guessing.

### 3. Use Project-Specific Skills

- Discover and apply project-specific skills relevant to the task.
- Follow any architecture, testing, or convention guidance provided by those skills.
- Project skills extend or specialize factory behavior; they do not replace it.

### 4. Make the Smallest Appropriate Change

- Implement only what is necessary to satisfy the acceptance criteria.
- Avoid refactoring, reformatting, or cleaning up unrelated code.
- If a change seems necessary for clarity, document it as a known concern.

### 5. Add/Update Tests

- Add tests that verify each acceptance criterion.
- Update existing tests if behavior changes.
- Ensure tests are meaningful: they should catch regressions, not just exercise code.

### 6. Run Targeted Validation

- Execute the project's `test-changed.ps1` script to run tests relevant to changed files.
- If that script is unavailable, run the most relevant unit or integration tests manually.
- Do not skip validation; even targeted validation provides signal.

### 7. Report Structured Completion Information

- Produce an implementation result conforming to `implementation-result.schema.json`.
- Include status, summary, files changed, tests run, test results, and acceptance criteria status.
- Note any known concerns, follow-up suggestions, and durable knowledge candidates.

### 8. Prepare/Update PR

- Create a new branch if not already on one.
- Commit changes with a clear, concise message.
- Create or update a pull request targeting the base branch.
- Link the PR to the issue.

## Retry Behavior

- If validation fails, analyze the failure and attempt a fix.
- Maximum implementation retries: 2 (see `policies/retry.yaml`).
- After the retry limit is reached, stop modifying code and trigger investigation.

## Output Format

Produce an implementation result conforming to `implementation-result.schema.json`:

```json
{
  "status": "success | failure",
  "summary": "Brief description of what was done",
  "filesChanged": ["path/to/file1", "path/to/file2"],
  "testsRun": ["test name or identifier"],
  "testResult": "passed | failed | partial",
  "acceptanceCriteriaStatus": "All criteria met | Partially met | Not met",
  "documentationUpdated": true,
  "knownConcerns": "Any concerns or caveats",
  "followUpSuggestions": "Recommended follow-up work",
  "durableKnowledgeCandidates": "Reusable knowledge discovered during implementation"
}
```

## Workflow Contract

- Your first action is `pwsh -NoProfile -File .ai/factory/scripts/route-state.ps1 -Event start -Issue <number>`, which moves the issue to `factory:working` (it refuses if the issue is not ready).
- Do **not** edit `factory:*` labels. Write the structured result to `.factory/implement-result.json` (create the directory), including the issue number in `issue` and the PR URL in `pr`. The workflow validates it and routes the issue state.
- Required for `status: success`: non-empty `filesChanged`, `testResult`, and `pr`. Use `status: failure` if you cannot finish; the issue is then routed to `factory:investigate`.
- Result files live under `.factory/`, which projects gitignore; never commit them.
