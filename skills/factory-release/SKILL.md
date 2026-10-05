---
name: factory-release
description: Push a completed cezar-factory version to configured project installations and reconcile their Cezar automations. Use after changing Factory-managed assets, workflows, scripts, policies, skills, or versioned templates.
---

# Factory Release

After validating a Factory change, deploy it to every explicit target with:

```powershell
pwsh -NoProfile -File scripts/push-factory-updates.ps1 -SyncAutomations
```

Targets live in the host-local `config/factory-projects.json` registry (copy the
checked-in `.example` first), or are passed explicitly with `-ProjectPath`.
Never discover projects by scanning drives or change an unlisted project.

The script validates the automation catalog, changes the project's version pin,
updates and verifies managed files, then reconciles Cezar automations. It
restores the original project pin if an update or synchronization fails. Report
each target that was successfully pushed and stop when any target fails.

Use `-DryRun` before a first deployment to a newly added target. Do not push
without the user's authorization to change the configured target projects.
