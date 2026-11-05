---
name: ship-deploy
description: Deploy a merged Factory fix - promote to stable (full test gate), force the Bazzite autodeploy, and confirm the host runs the promoted SHA. Use after a PR to dev has merged.
---

# Deploy a merged fix

Precondition: the fix is merged to the base branch and this checkout is clean on that merged commit
(`git fetch`, `git status`). Otherwise stop; do not deploy a branch or untested commit.

Run:

```powershell
pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Deploy            # add -DryRun first if unsure
```

It runs `scripts/release/promote-stable.ps1` (full suite, fast-forward only), then
`factory-autodeploy.sh --force` on the host named by `FACTORY_CONTROL_PLANE_SSH_TARGET`/`FACTORY_CONTROL_PLANE_FACTORY_DIR` in
`config/server-topology.env`, then compares the host SHA with `origin/stable`. See `homelab-ssh` for access.

Result: `SHIP_DEPLOYED sha=...` is success. Exit 4 means blocked (host not configured, or autodeploy exit
20 dirty / 21 diverged / 22 mismatch): report it verbatim and stop; never pull, reset, or edit the Bazzite
checkout. Exit 5 means the tests or deploy failed; report the output.
