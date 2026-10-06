<!--
managed-by: cezar-factory
source: skills/factory-work-backlog/SKILL.md
-->
# Factory Work Backlog Skill

Run the deterministic reconciler in dry-run mode before discussing eligible work:

```powershell
pwsh -NoProfile -File .ai/factory/scripts/reconcile-backlog.ps1 -InputPath .factory/github-issues.json -OutputPath .factory/backlog-reconciliation.json -DryRun
```

Report only its proposed legal actions, invalid states, exclusions, and caps.
Do not manually choose a lifecycle action, create a lease, dispatch Cezar, edit
`factory:*` labels, implement an issue, or merge a PR. A GitHub-visible claim
and explicit operator enablement are required before any future dispatch mode.
