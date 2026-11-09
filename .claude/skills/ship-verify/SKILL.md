---
name: ship-verify
description: Kick off verification of a deployed fix by re-running the same Factory workflow/automation in Cezar, recording the attempt against the issue. Use after ship-deploy.
---

# Queue the verification run

Re-run the workflow that originally exercised the issue (not a new verifier):

```powershell
pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Verify -Issue <N> -Automation <name-or-id>
```

`-Automation` accepts the automation id, its full name, or the short name without the `[factory] `
prefix; it defaults to `verify.defaultAutomation` in `.claude/ship/ship-loop.json`. Add `-DryRun` to see
what would be queued.

The tool queues the run through the Cezar API, records the attempt (sha, run id) in
`.factory/ship-loop/<project>-<N>.json`, and prints `SHIP_QUEUED {...}`. Report the run id, then hand off to
`ship-status`. Do not inspect the run's worktree or create tasks. Exit 3 = the attempt budget
(`maxDeployAttempts`) is spent: stop and tell the user. Exit 4 = Cezar API not configured in
`config/factory-projects.json`.

Schedule automations return a run id. Event-driven (GitHub) automations return a check id instead; the
run then has to be found in the cockpit run list.
