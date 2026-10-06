<!--
managed-by: cezar-factory
source: skills/factory-intake/SKILL.md
-->
# Factory Intake Skill

Classify a newly opened GitHub issue conservatively. Read the issue title,
body, and existing labels. Choose exactly one work type and risk label. Do not
assign complexity, edit lifecycle labels, implement code, or invent missing
requirements. If the issue contains a genuine unanswered product, security,
legal, or operational question, record it in `unresolvedQuestions`.

Write `.factory/intake-result.json` with `issue`, `type`, `risk`, `summary`,
and `unresolvedQuestions`. The workflow validates and routes the result.
