---
name: factory-release
description: Validate and force-synchronize Factory-managed assets to every explicitly configured Cezar project and Bazzite runtime.
---

# Factory release

Use this skill after any change under `scripts/`, `skills/`, `workflows/`,
`policies/`, `templates/`, `automations/`, or Factory versioning.

## Invariants

- Read targets only from `config/factory-projects.json`; never scan for or
  invent deployment targets.
- Always perform the release action on every invocation, even when the Factory
  version is unchanged. A matching version is not proof that the target is
  synchronized.
- Run catalog/release validation before synchronization.
- Remote-only targets receive automation synchronization through
  `scripts/push-factory-updates.ps1 -SyncAutomations`.
- Bazzite-hosted runtime changes also require the supported deployment flow
  from the Bazzite Factory checkout. Factory workflow commands run inside
  Cezar's Linux container; `/projects/cezar-factory` is an in-container mount,
  never a Windows path.
- Stop on a target failure and report the exact target; do not silently skip
  it or redirect to another project.

## Shared-mount release (default)

Projects use the Factory checkout mounted into Cezar, so releasing means promoting a tested
commit, not copying files into projects:

1. Make sure the change is committed and pushed, and the working tree is clean.
2. `pwsh -NoProfile -File .\scriptselease\promote-stable.ps1` runs the automation catalog check
   and the full test suite, then fast-forwards `origin/stable`. If it fails, stop and report the
   failure; never bypass it.
3. The Bazzite `factory-autodeploy` timer fast-forwards the mounted checkout and reconciles
   automations within five minutes. To deploy immediately use the `homelab-ssh` instructions to run
   `scripts/deploy/factory-autodeploy.sh --force` on the host, and report any BLOCKED exit (20 dirty,
   21 diverged, 22 container/host version mismatch) without touching the checkout.

The procedure below is the legacy per-project path; use it only for a project whose registry entry
is not `"mode": "shared"`.

## Procedure

1. Validate the changed assets and automation catalog.
2. Run the configured remote release for all targets:

   ```powershell
   pwsh -NoProfile -File .\scripts\push-factory-updates.ps1 -SyncAutomations
   ```

3. For Bazzite service/runtime changes, run the supported deployment script
   from the Bazzite checkout and verify the Cezar container sees
   `/projects/cezar-factory/scripts/factory-startup.ps1`.
4. Report successful targets and any target that failed because its Cezar
   project folder or deployment configuration is absent.
