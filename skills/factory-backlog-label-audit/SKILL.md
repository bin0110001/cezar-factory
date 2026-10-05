<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-backlog-label-audit/SKILL.md
-->
# Factory Backlog Label Audit Skill

Normalize legacy GitHub issues into the Factory taxonomy carefully. This is a label-only migration,
not triage and not implementation.

The repository being audited is the project named by the task. Do not create
Factory implementation issues there. Factory infrastructure defects belong in
`bin0110001/cezar-factory`; confirm the repository before creating an issue.
Never copy a private project's issue body or URL into a public repository without
explicit approval; report the needed Factory work and request a sanitized issue
if cross-repository tracking is required.

## Hard boundaries

- Do not change source code, issue title/body, milestones, assignments, projects, or issue state.
- Process **at most three** open issues in one run.
- Consider only the candidates emitted by `.ai/factory/scripts/audit-backlog-labels.ps1`. If that installed script is unavailable in an isolated worktree, use the self-contained fallback below; it fetches only open issues with no Factory label.
- Preserve every existing non-Factory label. Never remove a legacy/project label.
- Never use `FACTORY_RUNTIME_ROOT` for this audit. Before evaluation, run `pwsh -NoProfile -File ".ai/factory/scripts/audit-backlog-labels.ps1"` when that installed file exists. It ensures Factory labels using its own installed location and writes `.factory/backlog-label-audit-input.json`.
- For each selected issue, add exactly `factory:new`, one `type:*`, and one `risk:*` label. Do not add
  `agent:*` labels.
- Never apply `factory:needs-plan`, `factory:ready`, `factory:working`, `factory:review`, or any other
  Factory lifecycle label. `factory:new` is the only classification outcome; the candidate script's
  temporary `factory:needs-help` reservation is the sole exception.
- The candidate script first adds `factory:needs-help` to every candidate as a durable audit reservation. If an issue is an epic or tracking parent, replace that reservation with `factory:tracking` and record the reason; it is an intentional non-work classification, not a request for help. For blocked work, replace the reservation with `factory:blocked`. For other ambiguous, duplicate, decision-only, or decomposition-needed work, retain `factory:needs-help`. Each outcome prevents repeat evaluation without changing the issue body or adding a comment. A skipped issue without one of these durable closing labels is an audit failure, never a valid skip.

## Classification

Use existing labels as primary evidence: `bug` maps to `type:bug`; `test` maps to `type:test`;
`enhancement` maps to `type:feature`; `migration` or `architecture` maps to `type:refactor`;
documentation/localization-only work maps to `type:docs`. Otherwise use `type:maintenance` only for
maintenance/operational work. If no mapping is defensible, skip it.

Set `risk:high` only for security, destructive migrations, production/network credentials, or broad
architecture changes. Set `risk:medium` for normal code changes and `risk:low` for isolated tests,
documentation, or non-production maintenance. When uncertain, skip.

## Procedure

1. If `.ai/factory/scripts/audit-backlog-labels.ps1` exists, run it and read `.factory/backlog-label-audit-input.json`. Do not list additional issues. If it does not exist, do not stop and do not use `FACTORY_RUNTIME_ROOT`: ensure only the labels needed for the decision with `gh label create <label> --color <hex> --description <text> --force`, then list at most three candidates with `gh issue list --state open --limit 3 --search 'is:open -label:"factory:new" -label:"factory:needs-plan" -label:"factory:needs-help" -label:"factory:ready" -label:"factory:working" -label:"factory:review" -label:"factory:changes-requested" -label:"factory:human-review" -label:"factory:blocked" -label:"factory:done" -label:"factory:investigate" -label:"factory:tracking"' --json number,title,labels`. The fallback itself is the audit reservation: immediately add the accurate terminal label for every candidate after evaluating it.
2. Choose from its at-most-three candidates. Retrieve only those issue bodies if needed.
3. Re-read each candidate's labels immediately before writing, to avoid racing a human or another run. The expected audit reservation is `factory:needs-help`; if any other Factory label has appeared, record it as skipped without editing.
4. For every candidate, execute and re-read one closing label edit before reporting it. For classifiable work, replace the reservation with the three permitted labels using `gh issue edit <number> --remove-label factory:needs-help --add-label factory:new --add-label type:<type> --add-label risk:<risk>`; preserve all other labels. For an epic or tracking parent, run `gh issue edit <number> --remove-label factory:needs-help --add-label factory:tracking`; for blocked work, replace it with `factory:blocked`; for another deliberate skip, retain `factory:needs-help`. In the fallback, omit the `--remove-label factory:needs-help` argument because no reservation was added.
5. If the closing edit or re-read fails, stop the audit as failed. Do not call the issue skipped and do not emit a successful audit record. A `skipped` entry is valid only when its `added` array names the durable closing label visible in the re-read.
6. Re-read labels after each edit and write `.factory/backlog-label-audit.json`:

For the self-contained fallback, bootstrap these terminal labels immediately
before using one (the command is idempotent):

```powershell
gh label create factory:tracking --color 6f42c1 --description 'Factory: tracking parent, not executable work' --force
gh label create factory:blocked --color 1d76db --description 'Factory: blocked by an external dependency' --force
gh label create factory:needs-help --color 1d76db --description 'Factory: a human decision or input is needed' --force
```

Thus, for the reported outcomes, add `factory:blocked` to each blocked issue
and `factory:needs-help` to an issue that needs decomposition; do this even if
the installed candidate script is unavailable.

```json
{
  "considered": [123],
  "changed": [{"issue": 123, "added": ["factory:new", "type:bug", "risk:medium"]}],
  "skipped": [{"issue": 124, "reason": "tracking parent", "added": ["factory:tracking"]}]
}
```
