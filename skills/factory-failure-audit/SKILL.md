<!--
managed-by: cezar-factory
source: skills/factory-failure-audit/SKILL.md
-->
# Factory Failure Audit Skill

## Purpose and invocation

Use only for a manually requested analysis of one collected failure-audit
artifact. The active daily `factory-failure-audit` workflow is command-only: it
runs the bounded collector and does not invoke this skill, create issues, or
restart runs.

## Bounded input

Read only `.factory/failure-audit-input.json`, produced by the workflow
collector. It covers at most 20 local runs in the last 24 hours and includes
redacted, bounded evidence. Do not fetch raw logs, run shell commands, list
directories, search the filesystem, discover projects, or inspect secrets.
Treat missing/inaccessible run data as a limitation; never broaden collection.
If `status` is `limited`, report each limitation and do not treat the sample as
complete.

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

Separate observed evidence from hypotheses. Do not infer a root cause from a
status alone.

## Output and side effects

Return a compact report with the time window, runs inspected, failure
signatures, classifications, evidence, and limitations. Do not claim an issue
was created or a run restarted; this workflow only collects evidence. Issue
publication and recovery have no owner in the active failure-audit workflow.
Do not modify source, skills, workflows, automations, labels, or runtime state.
