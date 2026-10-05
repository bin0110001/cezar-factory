---
name: factory-release
description: Push a completed cezar-factory version to configured Cezar projects, using remote-only automation synchronization by default and local project installation as a fallback.
---

# Factory Release

After validating a Factory change, synchronize it to every explicit target with:

```powershell
pwsh -NoProfile -File scripts/push-factory-updates.ps1 -SyncAutomations
```

Targets live in the host-local `config/factory-projects.json` registry (copy the
checked-in `.example` first). The default target shape is remote-only:
`apiUrl` plus `projectId`, with no local application checkout. The release
syncs definitions directly from this Factory checkout.

Use a target with `projectPath` only when the project needs the full local
`.ai/factory` installation or version pin updated. That fallback updates and
verifies managed project files, then optionally reconciles Cezar automations.
Never discover projects by scanning drives or change an unlisted project.

The script validates the automation catalog, synchronizes remote automations,
or updates and verifies local managed files when `projectPath` is present. It
reports each target successfully pushed and stops when any target fails.

Use `-DryRun` before a first deployment to a newly added target. Do not push
without the user's authorization to change the configured target projects.
