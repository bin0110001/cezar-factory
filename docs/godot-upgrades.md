# Godot versions and automatic upgrades

## How a project picks its Godot version

`GODOT_BIN` in the Cezar container is `/usr/local/bin/godot`, a small selector, not a fixed
binary. It runs the version named by the first `.godot-version` file found walking up from the
working directory (contents such as `4.7-stable`). A task in a worktree therefore uses whatever its
branch pins. A project without a pin uses `GODOT_DEFAULT_VERSION`, the image baseline.

A version that is not installed yet is downloaded on demand into `GODOT_VERSIONS_DIR`
(`/opt/godot-versions`, the persistent `godot-versions` volume) by `godot-install`, which verifies
the release's `SHA512-SUMS.txt`. **Adopting a new Godot never needs an image rebuild or container
restart**; the image's `GODOT_VERSION`/`GODOT_CHANNEL` build args only choose the baseline.

`GODOT_VERSION_OVERRIDE=<tag>` forces a version for a single invocation.

## The `factory-godot-upgrade` workflow

Installed per project with `features.godot_upgrade: true` (local installs) or, for remote-only
targets, `"projectType": "godot"` in `config/factory-projects.json` (the `[factory] godot-upgrade`
automation is only synchronized to Godot projects). It runs daily at 03:00, and every script runs
from a `command:` step in `workflows/godot-upgrade.yaml`:

1. `check` - latest stable release (GitHub `releases/latest`, which excludes prereleases) vs the
   project's pin. Nothing newer, or branch `factory/godot-<version>` already exists: finish.
2. `stage` - `godot-install <version>` so tests do not pay for the download.
3. `apply` - branch `factory/godot-<version>` off `dev` (else the default branch), bump
   `.godot-version`, push. The pushed branch is the "already attempted" marker, so a release the
   agent cannot fix does not re-run daily. Delete the branch to retry.
4. `baseline-tests` - the project's Godot tests on the new version (failure recorded, not fatal).
5. `fix` - the agent adapts the project (`factory-godot-upgrade` skill); a no-op when tests passed.
6. `tests` - re-run; on failure retries `fix` up to twice, then the run fails visibly.
7. `publish` - commit the fixes, open the PR against `dev`, request auto-merge. Merging the PR is
   what switches the project: the container installs the pinned version when it is first needed.

Majors and minors are treated the same (fully automatic).

## Test command

`godot.testCommand` in the project's `.ai/factory/factory.config.yaml`, e.g.

```yaml
godot:
  testCommand: "bash addons/gdUnit4/runtest.sh -a test/scripts/gdscript --continue"
```

Without it the workflow falls back to `bash addons/gdUnit4/runtest.sh -a test --continue` when
gdUnit4 is present, and fails with a clear message otherwise. The command runs through `pwsh -Command`
in the worktree with the target version selected.

## Manual operations

- Try a version in a task: `GODOT_VERSION_OVERRIDE=4.8-stable $GODOT_BIN --version`.
- Pre-install: `podman exec cezar godot-install 4.8-stable`.
- Change the baseline: rebuild with `GODOT_VERSION=4.8` (compose build arg).
