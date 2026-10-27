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
  or edit Factory lifecycle labels. Do **not** edit `factory:*` labels or write `.factory/implement-result.json`; the workflow materializes it.
  Do not run Factory scripts; workflow command steps own validation and result routing.

## Fix process

- Inspect the latest findings against the current PR head. Fix only valid
  blocking findings within the issue scope; explain invalid or out-of-scope
  findings in the result.
- Keep changes limited to the findings. Update or add focused tests when
  behavior changes, and run the project's relevant commands. The workflow owns
  Factory validation and lifecycle routing.
- Return the existing PR URL and validation evidence. Do not post review
  comments or change labels; the workflow materializes the result, binds the
  selected issue, and returns the PR to review.
- Stop after the configured two fix rounds. Escalate unresolved compatibility,
  ownership, or system-contract decisions instead of expanding scope.

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
