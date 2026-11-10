# Shared Factory: one place to update

The shared Factory checkout mounted into Cezar is the default source of
workflows, skills, policies, and runtime scripts. Projects do not need a local
copy unless they require the optional `.ai/factory` layer.

```
reviewed PR -> dev -> factory-local-promotion validates exact SHA, activates dev, runs canaries
            -> policy advances stable -> factory-autodeploy reconciles Bazzite and Cezar
```

## Pieces

| Piece | What it does |
| --- | --- |
| `cezar` `CEZ_SHARED_WORKFLOWS_DIRS`, `CEZ_SHARED_SKILL_DIRS` | Extra read-only catalogs (path-delimited). Set in `integrations/bazzite/compose.yaml` to the mounted checkout's `workflows/` and `skills/`. A project's own `.ai/cezar/workflows` / `.ai/skills` entry with the same name wins, so a project can still override one. |
| `factory-local-promotion` timer | Normal promotion owner. Validates the exact merged `dev` SHA, activates the dev channel, runs canaries, then advances `stable` according to the configured promotion posture. |
| `scripts/deploy/factory-autodeploy.sh` + `integrations/bazzite/factory-autodeploy.{service,timer}` | Host side. Fast-forwards the mounted checkout to `origin/stable`, verifies the container sees the same Git SHA, `VERSION`, and content digest, then runs `scripts/sync-all-automations.ps1` inside Cezar on every healthy timer tick. Never resets, stashes or overwrites: unrelated dirty or diverged state stops it (exit 20/21). For compatibility with older checkouts, the exact generated Prometheus token file is accepted only if it is a regular file whose contents match `integrations/bazzite/.env`; the next commit ignores it. |
| `scripts/sync-all-automations.ps1` | Reconciles `[factory]` automations into every project in the host-local registry (`projectType` gates Godot-only automations). |
| `scripts/migrate-to-shared.ps1` | Consumes a fresh shadow-audit receipt, creates a separate migration worktree from `origin/dev`, and opens a PR containing only installed files whose manifest hash and normalized shared-source content still match. Modified files get review diffs; a backout record is committed before deletion. |
| `scripts/push-factory-updates.ps1` | Deprecated compatibility path. It uses automation-only sync for `mode: shared` targets and refuses mutations while configured release-controller or autodeploy locks are held. Keep it until a fresh audit receipt reports `legacyPushRetirementReady: true`. |

The retirement gate is fail-closed: it is true only for a complete audit with at least one target and every registered target classified `shared` or `migrated`. Unknown, remote-only, unreachable, modified, shadowed, or not-installed targets keep the legacy script in place. Configure `FACTORY_RELEASE_STORE` and `FACTORY_AUTODEPLOY_LOCK` (or target-specific `releaseStorePath` and `autodeployLockPath`) only where the owning workflow can access the same host lock files as the release services.

## Releasing

1. Merge the reviewed PR to `dev` after local validation and a recorded
   self-review.
2. The host promotion timer validates the exact commit, activates `dev`, runs
   canaries, and advances `stable` according to policy.
3. The host autodeploy timer reconciles the mounted checkout and Cezar runtime
   to `stable`. Read the host receipt or scheduler status for the outcome.
4. A Production Run selects the controlled posture. Manual stable promotion
   is reserved for an explicitly requested Production Run or a dead promoter.

## One-time host setup

```bash
git -C ~/cezar-factory fetch origin stable && git -C ~/cezar-factory checkout -B stable origin/stable
cp integrations/bazzite/factory-autodeploy.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now factory-autodeploy.timer
```

The host checkout must live where `FACTORY_CONTROL_PLANE_FACTORY_DIR` points, stay clean, and have
`config/factory-projects.json` (host-local, gitignored) so automations know their targets. Each timer
run writes an atomic `last-attempt.json` and preserves `last-success.json` in
`FACTORY_AUTODEPLOY_STATE_DIR` (default: `$XDG_STATE_HOME/cezar-factory/autodeploy`, or
`$HOME/.local/state/cezar-factory/autodeploy`). Failed parity or sync is retried on the next timer
tick even when the source SHA is unchanged. `--force` remains accepted for compatibility; normal
timer runs now perform the same parity and reconciliation checks. Changes to
the container definition or host configuration must use the supported
Bazzite deployment workflow; the remote-only Cezar sync does not deploy
`integrations/` files.

## Moving a project over

The `factory-migrate-to-shared` workflow handles a registered project. It refreshes the audit,
then creates a migration branch and pull request from a separate worktree. The receipt binds to the
registered project path; a mismatched checkout is refused. The project's original checkout stays
unchanged. Only files proven identical by the receipt, manifest and current shared
source are removed; modified files remain and receive local review-diff artifacts. The PR includes
`.ai/factory/migration-backout.json`, which records the base SHA and restore command. After the PR is
reviewed and merged, set `"mode": "shared"` on the project's registry entry so
`push-factory-updates.ps1` only synchronizes automations for it. Until then its installed copy
continues to shadow the shared one by name.
Project-specific changes to a Factory workflow belong in the project's own
`.ai/cezar/workflows/factory-<name>.yaml` (same `name:`), which wins over the shared copy.

## Trade-offs

Shared projects follow the mounted `stable` checkout; they do not pin Factory
versions in individual project configs. The host promotion timer revalidates
each merged commit and canary before `stable` advances. A rollback is a
reviewed revert through `dev` and the same promotion gates. Project-local
fallbacks remain version-pinned until they migrate to shared mode.
