<!--
managed-by: cezar-factory
source: skills/factory-intake/SKILL.md
-->
# Factory Intake Skill

## Purpose and invocation

Use only when a user asks for manual issue classification. The active
`factory-intake` workflow is script-only: it selects one issue, classifies it
with `classify-intake.ps1`, and does not invoke this skill.

## Input and judgment

Use only the single issue's title, body, and labels supplied in the task or in
`.factory/intake-issue.json`. Do not search for, list, or select other issues.
If that issue context is missing, stop and report the missing input.

Choose exactly one type (`type:bug`, `type:feature`, `type:refactor`,
`type:test`, `type:docs`, or `type:maintenance`) and one risk (`risk:low`,
`risk:medium`, or `risk:high`). Do not assign complexity. Resolve routine gaps
with the narrowest reversible assumption and state it in `summary`.

## Output and escalation

Write `.factory/intake-result.json` with `issue`, `type`, `risk`, `summary`,
and `unresolvedQuestions`, conforming to
`schemas/intake-result.schema.json`. Set `unresolvedQuestions` only when a
major architectural choice materially changes compatibility, ownership, or
the system contract. Risk level alone is never a reason to ask for approval.

Do not run Factory scripts. Do not edit labels or comments, implement code, or
discover replacement work. Workflow-owned validation and routing handle
lifecycle changes.
