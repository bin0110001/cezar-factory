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
- The workflow command runs the collector. Inspect only its compact,
  redacted artifact. It selects at most 20 local runs from the last 24 hours
  within a declared candidate and byte budget; do not fetch or parse raw run
  logs in the agent.
- Do not run directory listings, recursive searches, filesystem discovery, or
  commands that dump run logs.
- The audit runs in an isolated worktree. Do not search for an alternate
  script path.
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

If asked to classify a collected artifact, read only
`.factory/failure-audit-input.json`; do not run shell commands or inspect raw
logs. If it reports `limited`, report the limitation and stop. The collector
does not create issues or restart runs. Publication is a separate workflow
command tracked in #31 and must not treat incomplete evidence as complete.

For `project-defect`, `environment`, or `unknown`, summarize the evidence and
limitations in the audit report. Do not create an issue from this skill.

End with a compact report containing the time window, runs inspected, failure
signatures, classifications, issue number if created, and any limitations.
