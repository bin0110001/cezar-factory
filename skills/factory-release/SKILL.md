---
name: factory-release
description: Validate and release Factory-managed assets to explicitly configured Cezar projects and the shared Bazzite runtime.
---

# Factory release

Use this skill after any change under `scripts/`, `skills/`, `workflows/`,
`policies/`, `templates/`, `automations/`, or Factory versioning.

## Invariants

- Read targets only from `config/factory-projects.json`; never scan for or
  invent deployment targets. If the registry is absent or empty, stop after
  validation, report that target configuration is needed, and make no external
  changes.
- For a configured registry, perform the required release action for every
  listed target even when the Factory version is unchanged. A matching version
  is not proof that the target is synchronized.
- Run catalog/release validation before synchronization.
- Shared-mount promotion is allowed only after the validated implementation
  commit has merged to `dev` through the reviewed PR path. Promote that merged
  commit to `stable`; never promote a feature branch directly.
- Synchronize explicitly configured project targets through
  `scripts/push-factory-updates.ps1 -SyncAutomations`. The script follows each
  registry entry's shared, remote-only, or full-install mode; remote-only
  synchronization sends automation definitions, not Factory scripts or app
  files.
- Bazzite-hosted runtime changes also require the supported deployment flow
  from the Bazzite Factory checkout. Factory workflow commands run inside
  Cezar's Linux container; `/projects/cezar-factory` is an in-container mount,
  never a Windows path.
- Stop on a target failure and report the exact target; do not silently skip
  it or redirect to another project.

## Shared-mount release (default)

Projects use the Factory checkout mounted into Cezar. Release the reviewed,
tested merge commit, not an unmerged feature branch:

1. The implementation PR targets `dev` and has independent review plus the
   high-risk plan-approval gate when applicable. GitHub auto-merge is requested
   only after those gates pass. Release starts from the tested merged commit.
2. The shared-mount promotion entry point is
   `scripts/release/promote-stable.ps1`. It validates the automation catalog
   and full test suite before fast-forwarding `origin/stable`; it must not be
   invoked against an unmerged feature branch. On failure, stop and report the
   failure; never bypass it.
3. The configured-target synchronization procedure below follows promotion.
   The Bazzite `factory-autodeploy` timer advances the mounted checkout and
   reconciles automations. Immediate host deployment follows the `homelab-ssh`
   instructions and supported deployment flow; report any BLOCKED exit (20
   dirty, 21 diverged, 22 container/host version mismatch) without touching the
   checkout.

The configured-target procedure below covers every registry entry. Shared
entries synchronize automation definitions while workflows, skills and
scripts continue to come from the shared mount. A remote-only entry also
synchronizes automation definitions; a local `projectPath` is used only when
the target requires a full managed `.ai/factory` installation.

## Procedure

1. Validate the changed assets and automation catalog.
2. Configured-target synchronization uses
   `scripts/push-factory-updates.ps1` with automation synchronization enabled.
   It follows each target's shared, remote-only, or full-install mode and stops
   on a failed target.
3. For Bazzite service/runtime changes, the supported deployment path comes
   from the Bazzite checkout and verifies that Cezar sees
   `/projects/cezar-factory/scripts/factory-startup.ps1`.
4. Report successful targets and any configured target that failed because
   its Cezar project folder or deployment configuration is absent. If there is
   no registry, do not call the synchronization script; report that release is
   ready but awaits explicit target configuration.
