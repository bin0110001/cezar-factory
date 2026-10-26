<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-backlog-label-audit/SKILL.md
-->
# Factory Backlog Label Audit Skill

## Purpose and invocation

Normalize legacy labels on at most three ambiguous open issues. This is a
label-only migration, not triage or implementation. The active maintenance
workflow runs collection, validation, and deterministic classification before
invoking this skill; a later workflow step validates and applies the proposal.

## Prerequisites and bounded input

Read only the current-worktree `.factory/backlog-label-audit-input.json` and
the pre-fetched bodies of its remaining `candidates`. `resolved` entries have
already been applied and must not be proposed again. Do not discover issues,
run scripts or `gh`, inspect script source or raw logs, fetch issue bodies, or
read live GitHub state. If the validated input is missing or unreadable, report
the limitation and stop without a fallback lookup.

## Required judgment

Use the existing labels and supplied `typeHint`/`riskHint` as evidence. Map
`bug` to `type:bug`, `test` to `type:test`, `enhancement` to `type:feature`,
`migration` or `architecture` to `type:refactor`, and documentation or
localization to `type:docs`. Use `type:maintenance` only for operational work.
Set `risk:high` for security, destructive migration, production credentials,
or broad architecture changes; `risk:medium` for ordinary code changes; and
`risk:low` for isolated tests, documentation, or non-production maintenance.
When a type or risk is not defensible, use a durable human-escalation state
rather than inventing certainty.

Choose exactly one closing Factory state for each candidate:

- `factory:new` with exactly one type and one risk for classifiable work;
- `factory:needs-plan` with exactly one type, one risk, and
  `complexity:large` for work requiring decomposition;
- `factory:tracking` for an epic or tracking parent;
- `factory:blocked` for a confirmed external dependency;
- `factory:needs-help` only for a genuine human decision, missing external
  input, or conflicting requirement.

Do not add `agent:*` labels. Preserve existing project labels. Do not use
`factory:needs-help` merely because work is large or complex. Each proposal
needs a concise evidence-based rationale and a durable closing state; a bare
skip is invalid.

## Output and side effects

Return one JSON object matching the workflow schema. Include every candidate
exactly once across `changed` and `skipped`; `considered` must contain only
candidate issue numbers. Each `changed` or `skipped` entry needs its issue,
allowlisted `added` labels, and rationale. The deterministic consumer verifies
candidate completeness, reservation, open state, collected labels, and exact
revision before applying labels. If any of those checks fail, do not retry with
a new listing or apply labels manually.

Example:

```json
{
  "considered": [123],
  "changed": [
    {"issue": 123, "added": ["factory:new", "type:bug", "risk:medium"], "reason": "Existing bug label and report describe a reproducible defect."}
  ],
  "skipped": []
}
```
