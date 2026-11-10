# Factory synchronization

The shared Factory checkout mounted in Cezar is the default delivery path. A
project does not need its own copy of Factory workflows, skills, policies, or
runtime scripts. Project-local installation remains available only when a
project has a specific need for the full `.ai/factory` layer.

## Target registry

Release and synchronization use only the host-local
`config/factory-projects.json` registry. A target identifies its Cezar project
with `apiUrl` and `projectId`; `projectType` is optional. The `mode` field may
be `shared` when Cezar loads Factory assets from the mounted checkout. Shared
targets receive automation synchronization only through the legacy
compatibility path.

Use `projectPath` only when the project needs a full local Factory
installation. It must be an absolute, verified path on the machine running the
owning workflow. Never put a Cezar container path or a Bazzite-only path in
`projectPath`. Remote-only targets remain explicit and are reported as
`unknown` by the shadow-copy audit; the audit never searches for checkouts.

The optional `deployment.mode: remote-cezar-plus-bazzite-host` marks a target
whose Cezar synchronization also depends on the Bazzite runtime. That host's
service and configuration paths belong in `config/server-topology.env` and
the deployment inventory, not in a remote project path.

## Shared delivery and promotion

Factory changes are reviewed and merged to `dev`. The Bazzite
`factory-local-promotion` timer validates that exact merged commit, activates
the `dev` channel, runs canaries, then advances `stable` according to
`config/promotion-policy.json`. The `factory-autodeploy` timer reconciles the
host checkout and Cezar runtime to `stable`. A failed gate blocks advancement
and preserves its receipt for diagnosis. Do not move channel pointers or edit
the Bazzite checkout by hand.

The normal autonomous posture uses a passing local suite and recorded
self-review. A Production Run selects the controlled posture, which requires
its configured independent approval and soak gates. The manual stable
promotion script is a break-glass path for an explicitly requested Production
Run or a dead promoter; it is not the normal release mechanism.

## Shadow audit and migration

The read-only shadow audit examines only registered local project paths and
writes a schema-validated receipt. Each target is classified as shared,
shadowed, modified, not installed, unreachable, or unknown. Remote-only targets
remain unknown. The receipt's `legacyPushRetirementReady` field is true only
when the audit is complete, has at least one target, and every target is
classified `shared` or `migrated`.

The `factory-migrate-to-shared` workflow refreshes that receipt and prepares a
separate migration branch from `origin/dev`. It removes only files proven
identical by the receipt, installed manifest, and current shared source. It
keeps modified files and review diffs, records a schema-validated backout
before deletion, and leaves the original project checkout unchanged. After
the migration PR is reviewed and merged, set the target to `mode: shared`.
The backout record names the base SHA and per-file hashes needed to restore
the removed files.

The legacy `push-factory-updates.ps1` path is deprecated and remains available
until a fresh audit receipt opens the retirement gate. Shared-mode targets do
not receive managed-file updates. When the compatibility path is used, set
`FACTORY_RELEASE_STORE` and `FACTORY_AUTODEPLOY_LOCK` to the lock files on the
same host, or configure target-specific `releaseStorePath` and
`autodeployLockPath`. It holds those locks for the whole operation and stops
if a configured lock cannot be verified. Windows cannot inspect the host's
POSIX autodeploy lock, so that operation must run where the lock is accessible.

## Runtime and deployment boundary

Cezar loads workflows and skills from the read-only Factory mount configured
by `FACTORY_RUNTIME_ROOT`. Workflow `command:` steps own Factory script
execution. Workflow prompts and skills describe decisions and required
evidence; they do not ask the model to invoke Factory scripts.

Remote-only automation synchronization updates Cezar automation definitions.
It does not deploy application files or assets under `integrations/`. Changes
to Bazzite-hosted services use the supported deployment flow from the Bazzite
Factory checkout and its explicit topology inventory. For example,
`integrations/bazzite/litellm-config.yaml` is bind-mounted host configuration
and requires a service deployment after a change.

Projects that need project-specific workflows or guidance should use project
overrides and project-owned skills. Shared Factory workflows use the
project's own validation commands from its isolated worktree; those commands
must be project-owned and have bounded timeouts. See
[`project-integration.md`](project-integration.md) for the optional local
Factory layer and validation contract.

## Validation

Repository changes are validated on local compute with
`tests/run-tests.ps1`, the pre-commit hook, and the applicable local release
gate. The repository has no hosted CI. Project validation runs in the owning
Factory workflow and records its result in a head-bound receipt.
