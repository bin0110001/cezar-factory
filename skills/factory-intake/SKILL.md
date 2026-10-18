<!--
managed-by: cezar-factory
source: skills/factory-intake/SKILL.md
-->
# Factory Intake Skill

Classify a newly opened GitHub issue. Read the issue title, body, and existing
labels. Choose exactly one work type and risk label. Do not assign complexity,
edit lifecycle labels, or implement code. Resolve routine missing detail with
the narrowest reversible assumption and state it in `summary`. Record an
`unresolvedQuestions` value only when the issue requires a major architectural
choice that materially changes compatibility, ownership, or the system
contract. Risk level alone is never a reason to ask for user approval.

Write `.factory/intake-result.json` with `issue`, `type`, `risk`, `summary`,
and `unresolvedQuestions`. The workflow validates and routes the result.
