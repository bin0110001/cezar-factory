<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-backlog-label-audit/SKILL.md
-->
# Factory Backlog Label Audit Skill

Normalize legacy GitHub issues into the Factory taxonomy carefully. This is a label-only migration,
not triage and not implementation.

## Hard boundaries

- Do not change source code, issue title/body, milestones, assignments, projects, or issue state.
- Process **at most three** open issues in one run.
- Consider only open issues that have no `factory:*` label. Skip any issue with one or more Factory state labels.
- Preserve every existing non-Factory label. Never remove a legacy/project label.
- Before any label change, ensure the Factory labels exist with:
  `pwsh -NoProfile -File "$FACTORY_RUNTIME_ROOT/scripts/create-labels.ps1"`
- For each selected issue, add exactly `factory:new`, one `type:*`, and one `risk:*` label. Do not add
  `agent:*` labels.
- Never apply `factory:needs-plan`, `factory:ready`, `factory:working`, `factory:review`, or any other
  Factory lifecycle label. `factory:new` is the only permitted Factory state.
- Skip ambiguous, duplicate, decision-only, epic/parent, or blocked issues rather than guessing. Explain
  skips in the artifact. Do not comment on issues.

## Classification

Use existing labels as primary evidence: `bug` maps to `type:bug`; `test` maps to `type:test`;
`enhancement` maps to `type:feature`; `migration` or `architecture` maps to `type:refactor`;
documentation/localization-only work maps to `type:docs`. Otherwise use `type:maintenance` only for
maintenance/operational work. If no mapping is defensible, skip it.

Set `risk:high` only for security, destructive migrations, production/network credentials, or broad
architecture changes. Set `risk:medium` for normal code changes and `risk:low` for isolated tests,
documentation, or non-production maintenance. When uncertain, skip.

## Procedure

1. List open issues using `gh issue list --state open --limit 100 --json number,title,labels`.
2. Choose the first up to three eligible, unambiguous entries. Retrieve only those issue bodies if needed.
3. Re-read each chosen issue's labels immediately before writing, to avoid racing a human or another run.
4. Add the three permitted labels with `gh issue edit <number> --add-label ...`; preserve all other labels.
5. Re-read labels after each edit and write `.factory/backlog-label-audit.json`:

```json
{
  "considered": [123],
  "changed": [{"issue": 123, "added": ["factory:new", "type:bug", "risk:medium"]}],
  "skipped": [{"issue": 124, "reason": "ambiguous type"}]
}
```
