---
name: factory-finish-release
description: Validate a Factory update, complete the reviewed dev-PR handoff when its gates are met, and report configured release and runtime status.
---

# Factory finish and release

Use this skill whenever a completed change modifies Factory-managed assets such
as `scripts/`, `skills/`, `workflows/`, `policies/`, `templates/`,
`automations/`, Factory versioning, or Bazzite deployment definitions.

The goal is a verified handoff, not merely a source-tree change:

1. Validate the changed assets, automation catalog, release metadata, and the
   repository test suite appropriate to the change. Stop on a failed gate.
2. Check the diff and worktree for unrelated changes. Preserve user work; never
   reset, clean, stash, or overwrite it without explicit instruction.
3. Read targets only from `config/factory-projects.json`. If the registry is
   absent or empty, report that release is ready but needs target configuration
   and make no external release changes. Continue the repository review handoff
   when its gates are met.
4. Require independent review before the PR handoff. The implementation PR
   targets `dev`; request GitHub auto-merge only after review and any required
   high-risk plan approval. If no implementation PR exists, report that the
   review handoff remains outstanding. Do not create an unrelated PR or promote
   a feature branch.
5. After the reviewed PR has merged and a non-empty target registry is
   available, use an approved workflow-owned release automation for promotion
   and synchronization. If the automation is configured, queue it with
   `cez automation run <id>`, report the returned task ID, and stop. Do not
   inspect its worktree or create replacement tasks. If no approved release
   automation exists, report that gap; never run Factory scripts from a skill.
6. For Bazzite-hosted runtime changes, use the approved host deployment process.
   Verify that the host checkout matches the merged Factory version, the active
   workflow scripts exist in the host checkout and running Cezar container, the
   container uses the expected `/projects/cezar-factory` bind mount, and the
   supported health checks pass.
7. If the Bazzite checkout is dirty, on an unexpected revision, missing the
   required runtime, or cannot be validated, report the exact mismatch. Do not
   pull, reset, copy over, or delete the remote checkout.
8. Do not merge or promote a failed, unreviewed, unresolved, or blocked PR.

## Required handoff

Report the local version and validation result, each explicitly configured
target and its release result, Bazzite version/mount/runtime status, PR number
and base branch, review status, and auto-merge status. A release is complete
only when all applicable checks pass or a concrete external blocker is
reported.

## Important boundaries

- Remote-only Factory synchronization updates Cezar automation definitions; it
  does not deploy the full Factory runtime checkout or files under
  `integrations/`.
- A full runtime update uses the supported Bazzite host process and host-local
  configuration. Never put a remote container path in `projectPath`.
- Do not treat an empty issue queue, a matching version, or a successful
  automation API response as proof that the runtime is synchronized.
