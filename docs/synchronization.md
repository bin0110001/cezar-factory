# Factory Synchronization

How the factory is synchronized to Cezar by default, with local project
installation as a fallback. All scripts are PowerShell 7 and live in `scripts/`.

## Default release pipeline

Every Factory-managed change must force a release attempt on every configured
target, even when the Factory version is unchanged. A matching version does
not prove that the target's automations, runtime mount, or service deployment
is current.

Use remote-only synchronization whenever the target project already exists in
Cezar. Configure `apiUrl` and `projectId` in the host-local
`config/factory-projects.json`, omit `projectPath`, and run:

```powershell
./scripts/push-factory-updates.ps1 -SyncAutomations
```

This reads automation definitions and the Factory version from the current
checkout and updates only the target Cezar project's `[factory]` automations.
No application checkout is required.

Use the local installation/update flow below only when the target also needs
the full `.ai/factory` project layer.

## Cezar runtime registration

Factory workflows run in Cezar's isolated Git worktrees. Do **not** make a
workflow work by disabling worktree isolation, and do not depend on ignored or
untracked `.ai/factory` files being copied into a worktree. Cezar discovers
project workflows before it creates the worktree and materializes registered
skills for the agent; check steps need a separately registered runtime.

The supported deployment model is a version-pinned Factory checkout mounted in
the Cezar container and exposed as `FACTORY_RUNTIME_ROOT`. Factory automations
execute in Cezar; OpenHands is not required or used by the active automation
path. On the Bazzite
Factory host, set a host-local `FACTORY_RUNTIME_HOST_DIR` to the absolute path
of that checkout and mount it read-only at `/projects/cezar-factory`. Cezar's
service must then set:

```text
FACTORY_RUNTIME_ROOT=/projects/cezar-factory
```

The host checkout must contain
`scripts/audit-backlog-labels.ps1`. Remote targets with
`deployment.mode: remote-cezar-plus-bazzite-host` also run a mandatory Bazzite
runtime parity/deploy phase. It refuses a dirty or version-mismatched remote
checkout rather than syncing the automation definition to a runtime that
cannot execute it. Use `-SkipBazziteRuntime` only for an explicit
automation-only operation. `scripts/deploy/deploy-bazzite.sh`
preflights that file before starting the stack, so an hourly audit fails early
with an actionable deployment error instead of searching for scripts or
falling back to manual issue parsing. The Cezar service receives the read-only
runtime mount.

Factory workflow check commands call `$env:FACTORY_RUNTIME_ROOT/scripts/...`.
They write result artifacts to the current worktree, while schemas and policies
come from that versioned runtime. `route-state.ps1` therefore accepts the
current directory as its project path rather than inferring it from its script
location. A missing runtime variable is a deployment error that must fail the
check; it is never a reason to turn worktree isolation off.

## Where things land

Cezar only loads workflows and skills from fixed locations, so the installer writes there:

| Factory source | Project location | Why |
| --- | --- | --- |
| `workflows/X.yaml` | `.ai/cezar/workflows/factory-X.yaml` (workflow name `factory-X`) | Cezar's workflow directory; the prefix avoids clashing with built-in or project workflows |
| `skills/S/SKILL.md` | `.ai/skills/S/SKILL.md` | Shared skill location, also read by other agent tooling |
| `policies/*`, `schemas/*`, `routing/*` | `.ai/factory/policies`, `.ai/factory/schemas`, `.ai/factory/routing` | Read by the factory scripts |
| `scripts/{validate-result,route-state,hindsight/recall}.ps1` | registered Factory runtime (`$FACTORY_RUNTIME_ROOT/scripts/`) | Called by isolated-worktree workflow checks |
| `scripts/{sync-automations,create-labels}.ps1` | `.ai/factory/scripts/` | Operator-facing project management commands |
| `automations/*.json` | `.ai/factory/automations/` | Declarative definitions; applied to Cezar by `sync-automations.ps1` |

Written alongside: `.ai/factory/VERSION`, `.ai/factory/manifest.json` (path and SHA-256 of every managed file), `.ai/factory/gitignore.fragment`. The project-owned `.ai/factory/factory.config.yaml` is created once from the template and never overwritten.

## Commands

```powershell
./scripts/install.ps1 -ProjectPath ../proj -ProjectType godot [-DryRun]   # first install
./scripts/update.ps1  -ProjectPath ../proj -FactoryPath ../cezar-factory-0.2.0 [-DryRun]
./scripts/push-factory-updates.ps1 -ProjectPath ../proj -ForceManagedRefresh [-SyncAutomations]
./scripts/diff.ps1    -ProjectPath ../proj   # exit 1 on drift
./scripts/verify.ps1  -ProjectPath ../proj   # exit 1 on any failed check
```

The remote-only command can also be run directly for one Cezar project:

```powershell
./scripts/sync-automations.ps1 -SourceOnly -FactoryPath . -ApiUrl http://cezar:PORT -ProjectId <id> -DryRun
./scripts/sync-automations.ps1 -SourceOnly -FactoryPath . -ApiUrl http://cezar:PORT -ProjectId <id>
```

This remote-only mode updates only Cezar's `[factory]` automations. It does not
install project workflows, skills, policies, or scripts; those still require a
local or mounted project checkout.

It also does not deploy files under `integrations/`. Those are host deployment
assets. For the Bazzite control plane, keep `config/server-topology.env` and
the host-local `integrations/bazzite/.env` authoritative, then run
`scripts/deploy/deploy-bazzite.sh` from the Bazzite checkout. This recreates
the Compose configuration and restarts the selected services. A Bazzite
deployment may use a host-local bind-mounted config path even when no local
Windows `projectPath` exists; do not encode that remote path as `projectPath`.

For a target that needs both Cezar automation synchronization and the complete
project Factory layer, the registry entry must include an absolute Windows
`projectPath` pointing to a verified checkout. Use `-DryRun` before the first
deployment and confirm the project contains `.ai/factory/factory.config.yaml`.

`-FactoryPath` is a checkout of the factory at the version the project pins (default: the checkout the script runs from). The scripts refuse to run when that checkout's `VERSION` differs from the pin, so a project never follows `main` by accident.

## Ownership and safety

- Every managed `.md`, `.yaml` and `.ps1` file carries a managed-by header (`GENERATED BY CEZAR-FACTORY` / `managed-by: cezar-factory`) with the version and source path. JSON files are tracked through the manifest only.
- Only paths listed in the manifest are ever overwritten or removed.
- If a file already exists at a managed path and is not in the manifest, ownership is ambiguous: install/update refuses and writes nothing.
- If a manifest-listed file was edited locally, update refuses and names it. Move the change into an override instead.
- Obsolete managed files (dropped by the new version) are removed; empty directories are tidied.
- `-DryRun` prints the full change summary and writes nothing.

### Forced managed refresh

`-ForceManagedRefresh` is the deliberate recovery path when a previously
installed Factory layer has drifted so far that the normal updater refuses it.
It archives `.ai/factory` plus only `factory-*` workflow and skill files under
`.factory/factory-force-backups/<timestamp>`, then reinstalls the pinned
Factory version and runs `verify.ps1`. Project-owned skills and workflows are
not removed. Use it only after reviewing the failed normal update; a failed
verification still blocks the release.

## Upgrade and rollback

1. Edit `factory.version` in `.ai/factory/factory.config.yaml`.
2. Run `update.ps1` against a checkout of that version. It prints `Factory 0.1.0 -> 0.2.0` with Updated / Added / Removed lists, then runs `verify.ps1`.
3. Review the Git diff, run project CI, commit.

Rollback is the same procedure with the previous pin and the previous checkout. Old factory versions stay available as git tags.

## Overrides

A file at `.ai/factory/overrides/<factory source path>` fully replaces that factory file, for example `overrides/policies/retry.yaml` or `overrides/workflows/implement.yaml`. The installer renders the override into the managed location (header `source: overrides/...`), so `diff.ps1` stays clean and upgrades keep the override. `verify.ps1` rejects an override whose path does not exist in the factory. There is no patch/merge mode in v0.1. Prefer composing with project skills in `.ai/skills/` over replacing a factory skill.

## Automations

Cezar keeps live automations in its own gitignored store (`.ai/cezar/automations.json`) and exposes them over HTTP, so they cannot be installed as files. The factory ships definitions and `sync-automations.ps1` converges the cockpit onto them:

```powershell
$env:CEZ_API_URL = 'http://localhost:PORT'; $env:CEZ_PROJECT_ID = '<id>'   # Cezar must run with CEZ_AUTOMATIONS=1
./.ai/factory/scripts/sync-automations.ps1 -DryRun
./.ai/factory/scripts/sync-automations.ps1 [-Enable] [-Prune]
```

- Factory automations are named `[factory] <name>`; nothing else is ever modified.
- Missing ones are created paused (`-Enable` creates them enabled, which baselines to now, so the backlog is not launched). Changed ones are updated with their enabled state preserved. Obsolete ones are paused, or deleted with `-Prune`.
- The factory version is recorded in each description. Results are logged to `.factory/automation-sync.log`.

## CI

`tests/run-tests.ps1` is the factory's own CI (`.github/workflows/ci.yml`): static checks, plus install, drift, upgrade, rollback, override, ambiguity, result-validation, state-routing (fake `gh`) and automation-sync (mock cockpit) scenarios against the fixture projects in `tests/fixtures/`. Projects can run `diff.ps1` and `verify.ps1` in their own CI.
