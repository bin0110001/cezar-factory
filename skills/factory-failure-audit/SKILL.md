<!--
managed-by: cezar-factory
source: skills/factory-failure-audit/SKILL.md
-->
# Factory Failure Audit Skill

Audit one registered project for recent Cezar workflow failures and identify
whether the failure is likely in the application or in a Factory-managed
skill, workflow, automation, schema, policy, or runtime contract.

## Scope and safety

- This is a read-only audit. Do not modify source code, skills, workflows,
  automations, labels, or runtime state.
- Inspect only the compact artifact emitted by
  `audit-factory-failures.ps1`. The script fetches and filters at most 20
  recent run records; do not fetch or parse raw run logs in the agent.
- Do not run directory listings, recursive searches, filesystem discovery, or
  commands that dump run logs.
- The audit runs in an isolated worktree. Use the exact shared project path
  supplied by the workflow when invoking the script; do not search for an
  alternate path.
- Do not search other drives, discover unregistered projects, or inspect
  secrets, tokens, or unrelated application data.
- Treat a missing or inaccessible run directory as an audit finding, not as
  permission to broaden the search.

## Classification

Classify each distinct failure as one of:

- `factory-defect`: evidence points to a Factory-managed asset or runtime
  contract, such as a bad workflow command, invalid schema kind, missing
  managed skill, automation drift, or version mismatch.
- `project-defect`: evidence points to application code, project tests, or
  project configuration outside the Factory layer.
- `environment`: evidence points to Cezar, a provider, the host, or a missing
  dependency rather than either codebase.
- `unknown`: evidence is insufficient.

## Required action

The workflow runs the collector before the agent step. Read only
`.factory/failure-audit-input.json`; do not run shell commands or inspect raw
logs. If the artifact reports `limited`, report the limitation and stop.

If at least one recognized Factory runtime/workflow signature is found, the
collector creates at most one GitHub issue in the current project with labels
`factory:new`, `type:maintenance`, and `risk:medium`, deduplicated against open
issues with the same audit title. The agent must not create a second issue.
The issue must include the affected project, run IDs, exact failing step and
command, relevant artifact paths, the Factory asset suspected, and a clear
acceptance criterion. State explicitly that the eventual implementation must
be made in the `cezar-factory` source checkout and released to every target in
`config/factory-projects.json` before closure.

For `project-defect`, `environment`, or `unknown`, do not create an issue
unless the evidence supports a concrete next action; summarize it in the
audit report instead. Never create more than one issue per audit run.

End with a compact report containing the time window, runs inspected, failure
signatures, classifications, issue number if created, and any limitations.
