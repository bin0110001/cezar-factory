# Shared Factory: one place to update

Projects no longer carry their own copy of the Factory. Cezar loads Factory workflows and skills
straight from the Factory checkout mounted into the container, and Factory scripts already ran from
that mount, so **updating that one checkout updates every project**.

```
dev work -> tests/run-tests.ps1 passes -> promote-stable.ps1 -> origin/stable
         -> (timer, every 5 min) factory-autodeploy.sh on Bazzite fast-forwards the mounted checkout
         -> Cezar sees new workflows/skills/scripts immediately; automations are reconciled
```

## Pieces

| Piece | What it does |
| --- | --- |
| `cezar` `CEZ_SHARED_WORKFLOWS_DIRS`, `CEZ_SHARED_SKILL_DIRS` | Extra read-only catalogs (path-delimited). Set in `integrations/bazzite/compose.yaml` to the mounted checkout's `workflows/` and `skills/`. A project's own `.ai/cezar/workflows` / `.ai/skills` entry with the same name wins, so a project can still override one. |
| `scripts/release/promote-stable.ps1` | The deploy gate. Requires a clean checkout, a valid automation catalog and a passing full test suite, then fast-forwards `origin/stable`. No skip switch; a failure moves nothing. |
| `scripts/deploy/factory-autodeploy.sh` + `integrations/bazzite/factory-autodeploy.{service,timer}` | Host side. Fast-forwards the mounted checkout to `origin/stable`, checks the container sees the same `VERSION`, then runs `scripts/sync-all-automations.ps1` inside Cezar. Never resets, stashes or overwrites: a dirty or diverged checkout stops it (exit 20/21). |
| `scripts/sync-all-automations.ps1` | Reconciles `[factory]` automations into every project in the host-local registry (`projectType` gates Godot-only automations). |
| `scripts/migrate-to-shared.ps1` | Removes a project's installed Factory copy (everything in its manifest) so the shared one is used. Keeps the project-owned `factory.config.yaml`. |

## Releasing

1. Merge the change (reviewed PR to `dev`, as before).
2. From the merged commit: `pwsh scripts/release/promote-stable.ps1`.
3. Wait up to 5 minutes, or on the host run `scripts/deploy/factory-autodeploy.sh --force`.

## One-time host setup

```bash
git -C ~/cezar-factory fetch origin stable && git -C ~/cezar-factory checkout -B stable origin/stable
cp integrations/bazzite/factory-autodeploy.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now factory-autodeploy.timer
```

The host checkout must live where `FACTORY_CONTROL_PLANE_FACTORY_DIR` points, stay clean, and have
`config/factory-projects.json` (host-local, gitignored) so automations know their targets.
Redeploy the Cezar container once (`deploy-bazzite.sh`) so it gets the new environment variables.

## Moving a project over

`pwsh scripts/migrate-to-shared.ps1 -ProjectPath <project> -DryRun`, then without `-DryRun`, commit,
and set `"mode": "shared"` on its registry entry so `push-factory-updates.ps1` only synchronizes
automations for it. Until a project is migrated its installed copy shadows the shared one by name.
Project-specific changes to a Factory workflow belong in the project's own
`.ai/cezar/workflows/factory-<name>.yaml` (same `name:`), which wins over the shared copy.

## Trade-offs

Projects no longer pin a Factory version: they follow `stable`. The test gate and one-commit
rollback (`git revert`, promote again) are the safety net. Scripts and workflows change together
because both come from the same checkout, which removes the version-skew failures the per-project
copies caused.
