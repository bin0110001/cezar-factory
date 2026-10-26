---
name: factory-finish-release
description: Finish a Factory-managed update by validating it, synchronizing every configured target, verifying Bazzite runtime parity, and preparing the reviewed dev PR for auto-merge.
---

# Factory finish and release

Use this skill whenever a completed change modifies Factory-managed assets such
as `scripts/`, `skills/`, `workflows/`, `policies/`, `templates/`,
`automations/`, Factory versioning, or the Bazzite deployment definitions.

The goal is a verified end state, not merely a source-tree change:

1. Validate the changed assets and the automation catalog. Run the repository
   test suite appropriate to the change. Stop on any failed validation; do not
   release a failed or unresolved update.
2. Check the diff and working tree for unrelated changes. Preserve user work;
   never reset, clean, stash, or overwrite it without explicit instruction.
3. Read deployment targets only from `config/factory-projects.json`. If the
   registry is absent or empty, report that the release is ready but needs
   target configuration and make no external release changes: do not promote
   `stable`, synchronize targets, or deploy. Continue the required repository
   review handoff when its gates are met.
4. Require independent review before the PR handoff. The implementation PR
   targets `dev`; request GitHub auto-merge only after review and any required
   high-risk plan approval. If no PR exists, report that handoff instead of
   creating an unrelated PR. Do not promote `stable` from the feature branch.
5. After the reviewed PR has merged and a non-empty target registry is
   available, follow the `factory-release` procedure from the tested merged
   commit. It promotes that commit to `stable` only after the catalog and full
   suite pass, then synchronizes every configured target with
   `scripts/push-factory-updates.ps1 -SyncAutomations`, even when the Factory
   version appears unchanged. If target configuration is still missing,
   defer these external release actions. Never scan drives or invent targets.
6. For Bazzite-hosted runtime changes, use the `homelab-ssh` instructions and
   the supported Bazzite deployment flow. Verify all of the following before
   declaring success:
   - the host checkout `VERSION` equals the local Factory `VERSION`;
   - every script referenced by the active Factory workflows exists in the
     host checkout;
   - the Cezar container bind-mounts that checkout at
     `/projects/cezar-factory`;
   - the same required scripts exist inside the running `cezar` container;
   - the supported deployment validation and health checks pass.
7. If the Bazzite checkout is dirty, on an unexpected revision, missing the
   required runtime, or cannot be validated, stop and report the exact
   mismatch. Do not pull, reset, copy over, or delete the remote checkout.
8. Do not merge or promote a failed, unreviewed, unresolved, or blocked PR.

## Required handoff

Report the local version, validation result, every configured target and its
release result, Bazzite version/mount/runtime result, PR number/base branch,
review status, and auto-merge status. A release is complete only when all
applicable checks pass or a concrete external blocker is reported.

## Important boundaries

- Remote-only Factory synchronization updates Cezar automations; it does not
  deploy the full Factory runtime checkout or files under `integrations/`.
- A full runtime update must use the supported Bazzite deployment flow and
  host-local configuration. Never put a remote container path in
  `config/factory-projects.json` as a Windows `projectPath`.
- Do not treat an empty issue queue, a matching version string, or a successful
  automation API response as proof that the runtime is synchronized.
