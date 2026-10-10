<!--
managed-by: cezar-factory
factory-version: 0.3.33
source: skills/factory-implement/SKILL.md
-->
# Factory Implement Skill

## Responsibilities

- Consume the prepared `.factory/implementation-context.json` handoff.
- Read the approved issue plan from the prepared issue body/comments.
- Follow acceptance criteria.
- Use project-specific skills.
- Make the smallest appropriate change.
- Add/update tests.
- Run targeted validation where appropriate.
- Report structured completion information.
- Explicitly verify substantive acceptance criteria and report whether required
  documentation was updated. Set `documentationUpdated` to `false` when the
  documentation review finds that no update is needed.
- Prepare/update PR.

## Detailed Guidance

### 1. Read the Prepared Issue Context and Approved Plan

- Read `.factory/implementation-context.json` before any discovery. It must
  contain the issue number, URL, body/comments, nearest project instructions,
  and environment metadata written by `prepare-implementation.ps1`.
- Work only on the prepared issue. Treat the recorded issue and approved plan
  as authoritative. If the artifact is missing, stale, malformed, or names a
  different issue than the workflow prompt, report the environment blocker and
  stop. Do not repeat broad issue discovery.
- Do not use anonymous GitHub `curl` calls or guess repository owners; the
  preparation script already performed the authenticated issue read.
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
- Do not dispatch a child Cezar task from an implementation run. The current
  run already owns the issue and its isolated worktree.

### 3a. Command and Environment Discipline

- Use the shell and tools provided by the runner. Do not switch to `/bin/sh`,
  invent container paths, or replace a failed command with one whose semantics
  are unknown.
- Invoke Factory scripts from `$FACTORY_RUNTIME_ROOT/scripts/...` and project
  scripts from the current worktree. Never hard-code `/projects/...` or another
  machine-specific path.
- A non-zero command is evidence to inspect: capture its complete error, check
  the command help or manual, and retry at most once with corrected syntax. If
  the second attempt shows a missing tool, inaccessible runtime, or unavailable
  credential, stop and write a failure result with the blocker. Do not spend
  the run trying unrelated commands.
- Do not run workflow verification or result-validation commands inside the
  skill; those are separate workflow steps. Leave the result artifact for them.
- Do not use Cezar task/automation commands for issue lookup or implementation
  delegation.

### 4. Make the Smallest Appropriate Change

- Implement only what is necessary to satisfy the acceptance criteria.
- Avoid refactoring, reformatting, or cleaning up unrelated code.
- If a change seems necessary for clarity, document it as a known concern.

### 5. Add/Update Tests

- Add tests that verify each acceptance criterion.
- Update existing tests if behavior changes.
- Ensure tests are meaningful: they should catch regressions, not just exercise code.

### 6. Run Targeted Validation

- Run the project's own test commands while developing. The workflow runs `test-changed.ps1` and the full verification itself after you finish; do not run those Factory scripts.
- If that script is unavailable, run the most relevant unit or integration tests manually.
- Do not skip validation; even targeted validation provides signal.
- If the test script fails because the runtime command itself is unavailable,
  distinguish that infrastructure failure from a test failure; do not claim
  the tests passed.

### 7. Report Structured Completion Information

- Produce an implementation result conforming to `implementation-result.schema.json`.
- Include status, summary, files changed, tests run, test results, and acceptance criteria status.
- Note any known concerns, follow-up suggestions, and durable knowledge candidates.

### 8. Prepare/Update PR

- Create a new branch if not already on one.
- Commit changes with a clear, concise message.
- Create or update a pull request targeting the configured `dev` base branch.
  After validation and independent approval, the review router requests GitHub
  auto-merge into `dev`.
- Link the PR to the issue.

### 9. Factory-managed asset release gate

When the change touches a Factory-managed asset or its source equivalent
(`skills/`, `workflows/`, `automations/`, `policies/`, `templates/`,
`scripts/`, schemas, or Factory versioning), the implementation is not
complete after the PR alone. Validate the Factory checkout, run the
`factory-release` procedure, and synchronize every explicitly configured
target from `config/factory-projects.json`. Do not discover targets by scanning
drives. If the required Factory checkout or target registry is unavailable,
report the implementation as blocked or incomplete rather than claiming
success. Record the release output and any target that could not be updated.

## Retry Behavior

- If validation fails, analyze the failure and attempt a fix.
- Maximum implementation retries: 2 (see `policies/retry.yaml`).
- After the retry limit is reached, stop modifying code and trigger investigation.
- Retries must address the reported failure. Repeating the same failed command,
  changing shells, or searching unrelated paths is not a retry.

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

- The workflow has already prepared `.factory/implementation-context.json` and moved the issue to `factory:working`. Do **not** run Factory scripts (`route-state.ps1`, `prepare-implementation.ps1`, `validate-result.ps1`, ...); the workflow owns every script step.
- Do **not** edit `factory:*` labels. Write the structured result to `.factory/implement-result.json` (create the directory), including the issue number in `issue` and the PR URL in `pr`. The workflow validates it and routes the issue state.
- Required for `status: success`: non-empty `filesChanged`, `testResult`, and `pr`. Use `status: failure` if you cannot finish; the issue is then routed to `factory:investigate`.
- Result files live under `.factory/`, which projects gitignore; never commit them.

## Already-resolved issues

The workflow's first step (`check-already-resolved.ps1`) finishes work on a closed or `factory:done` issue by
writing `.factory/already-resolved.json`. If that file exists, reply with one line saying the issue is already
resolved and stop: no discovery, no edits, no result file. Every later workflow step then no-ops.
