---
name: factory-workspace
description: Manage an external coding session's local issue workspace through the shared Cezar lifecycle CLI. Use for coding work outside a verified Factory workflow, or to inspect and recover an interrupted local workspace.
---

# Factory workspace lifecycle

Use `cez workspace` for local ownership and recovery. The registry is host-local and
SQLite-backed; Git remains authoritative for branches, commits, and worktrees.

## Before editing

1. Run `cez workspace context` from the repository. If it reports `managed: true`,
   Factory owns this run. Do not claim, adopt, validate, or clean up its workspace.
2. If `FACTORY_MANAGED=1` is present but context verification fails, inspect
   `cez workspace status` and `cez workspace doctor`. Treat that as stale or
   inconsistent ownership and stop for operator recovery; do not fall through to
   an external claim.
3. Use the issue already selected in the task context. Do not search GitHub for
   replacement work. If no issue was supplied, ask the user which issue this work
   belongs to before creating an issue claim.
4. Inspect the local registry with `cez workspace status --issue <id>`.
   Use `cez workspace overlaps` to see advisory file overlap with other local
   issues. Continue independent work; coordinate only the overlapping paths.
   - If the current developer-created worktree is the intended workspace, register
     it with `cez workspace adopt --issue <id>`. Adoption records the path and branch
     without changing files, even when the worktree is dirty.
   - If no workspace exists, run `cez workspace claim --issue <id>`. It prints the
     isolated worktree path. Continue all edits in that path (set the agent's working
     directory to the printed path, or pass it with `--repo <path>` to later CLI
     commands).
   - If another owner holds the issue, preserve both workspaces and report the
     ownership conflict. Do not force a second claim.

## Finishing work

Commit the intended changes and keep the workspace clean before running
`cez workspace validate --issue <id>`. The
repository must configure an argv array in
`.ai/cezar/workspace-lifecycle.json`, for example `{"validation":["npm","test"]}`.
The command runs without a shell, marks the workspace `ready` only on exit code 0,
and returns it to `working` on failure. Report the actual command output.

`ready` means the coding phase passed validation and awaits integration. Do not claim
that GitHub merged a PR based on a local clean merge or an auto-merge request. The
core retains Factory-created worktrees until verified integration. After GitHub
reports the PR as merged, `cez workspace integrate --issue <id> --pr <number-or-url>`
verifies the merged commit is on the configured target, runs post-integration checks
against that combined commit, records the evidence, and then attempts safe cleanup.
It never prunes adopted developer workspaces.

## Recovery

Use `cez workspace doctor` to compare registry records with Git worktrees. Use
`cez workspace recover --issue <id>` only after the lease expired and the previous
owner process is confirmed dead. `--force` is an audited operator override for an
owner whose liveness cannot be verified; do not use it merely to clear a conflict.
`cez workspace prune --issue <id>` removes only a clean Factory-created worktree
that has reached `cleanup_pending` after integration.

The registry is local to this host. Two disconnected machines can claim the same
GitHub issue independently; reconcile their branches and ownership before pushing.
