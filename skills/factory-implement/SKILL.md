<!--
managed-by: cezar-factory
factory-version: 0.3.33
source: skills/factory-implement/SKILL.md
-->
# Factory Implement Skill

## Contract

Implement the one issue selected by the Cezar workflow and return its typed
result. The prepared issue, approved plan, acceptance criteria, and non-goals
define the scope. Use the current task worktree; this run already owns the issue.

### Prerequisites and bounded input

- Read `.factory/implementation-context.json` before discovery. It must match
  the workflow task and contain the selected issue, plan context, nearest
  project instructions, and environment metadata. If it is missing, stale,
  malformed, or mismatched, report the blocker and stop without editing.
- Use the prepared issue and approved plan as authoritative. Do not search for
  or select other issues, repeat workflow discovery, or guess repository owners.
  Do not use anonymous GitHub `curl` calls.
- Read relevant project instructions and skills. Inspect only the repository,
  tests, and artifacts needed for the acceptance criteria; keep unrelated logs
  and memory out of context.

### Required judgment

- Meet each acceptance criterion with the smallest appropriate change. Do not
  expand scope; resolve routine ambiguity with a documented reversible
  assumption. Escalate only a major decision that materially changes
  compatibility, ownership, or the system contract.
- Add or update meaningful tests for changed behavior. Review documentation
  relevance and report whether it changed.
- Use project-owned development and validation commands. Do not run Factory
  workflow scripts, workflow verification, or result validation from this
  skill; their command steps own those operations.
- A command failure is evidence to inspect. Capture the complete error, check
  command help or documentation, and retry at most once with corrected syntax.
  If it still fails, or two consecutive tool calls are spent cleaning up that
  failure, stop and return a failure result with the blocker. Repeating the same failed command,
  switching shells,
  deleting/recreating paths, or searching unrelated paths is not recovery.
- Do not hard-code machine-specific paths or switch to a shell with unknown
  semantics. Prefer structured file editing for multiline changes.
- Do not dispatch a child Cezar task. The current workflow owns this issue and
  its isolated worktree.

### Workflow-owned operations and forbidden effects

The workflow prepares context, owns lifecycle labels and routing, runs changed
and full verification, validates and persists the result, and handles
finalization. Never run Factory scripts, extract an issue number for one, edit
`factory:*` labels, write `.factory/implement-result.json`, or commit generated
workflow artifacts. Do not bypass retry, review, or release gates.

For implementation retries, fix the reported test regression. `policies/retry.yaml`
allows at most two retries. After the limit, stop modifying
code and return a failure result for investigation. Infrastructure failures,
missing tools, malformed results, or unknown failures do not authorize a code
repair retry.

## Result and handoff

Return one JSON object matching `implementation-result.schema.json` and the workflow output contract; never write `.factory/implement-result.json`.
The workflow materializer binds the issue identity from the prepared context.
Include `status`, `summary`, `filesChanged`,
`testsRun`, `testResult`, `acceptanceCriteriaStatus`, `documentationUpdated`,
`knownConcerns`, `followUpSuggestions`, and `durableKnowledgeCandidates`.
Successful results require non-empty `filesChanged`, `testResult`, and `pr`.
Use `status: failure` with the observed blocker when work or validation cannot
finish. Set `documentationUpdated` to `false` when review finds no needed
documentation change.

Example successful result:

```json
{
  "status": "success",
  "summary": "Implemented the planned change.",
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

Prepare or update the issue-linked PR targeting `dev`; do not merge or request
auto-merge yourself. Independent review and any required high-risk plan
approval precede the workflow's auto-merge handoff. A successful result means
the implementation is ready for review, not merged or released.

For Factory-managed changes (`skills/`, `workflows/`, `automations/`,
`policies/`, `templates/`, `scripts/`, schemas, or Factory versioning), identify
the changed Factory assets in the result. The reviewed finish-release process
handles configured-target synchronization and runtime parity after merge; do
not claim deployment or release from implementation success.
