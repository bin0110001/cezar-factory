---
name: ship-deploy
description: Watch a merged Factory fix go through the host promoter (validate, activate dev, canaries, stable, deploy) and report where it landed. Use after a PR to dev has merged.
---

# Deploy a merged fix

Promotion is automatic and owned by the host promoter (`docs/promotion-pipeline.md`). This skill never
promotes by hand and never touches a channel pointer; it nudges the promoter and reports its state.

Precondition: the fix is merged to `dev` (`gh pr merge <n> --squash` for broken-code fixes) and your checkout
is on, or behind, `origin/dev`. Otherwise stop: only merged work is promoted.

Run:

```powershell
pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Deploy            # add -DryRun first if unsure
```

It starts `factory-local-promotion.service` on the host named by `FACTORY_CONTROL_PLANE_SSH_TARGET` in
`config/server-topology.env`, then polls `factory_local_scheduler.py status --sha <dev head>` and prints
`SHIP_PROGRESS` lines as the candidate moves. See `homelab-ssh` for access.

Result: `SHIP_DEPLOYED sha=...` means the SHA passed the suite and the canaries and the `stable` channel
serves it. Exit 4 is blocked (missing evidence such as a PR without a self-review, an open circuit breaker,
or host config missing): report it verbatim and stop. Exit 5 means the promotion failed; the previous release
stays active, a `[promotion]` issue was opened, and the fix is another merge to `dev`. Exit 6 means it is
still running; run Deploy again to keep watching. Never pull, reset, or edit the Bazzite checkout.
