---
name: factory-orphaned-pr-merge
description: Recover and merge explicitly assigned, non-draft pull requests whose original implementation task is no longer active.
---

# Factory orphaned pull request recovery

Use this skill when a maintainer explicitly assigns recovery of an open pull
request whose original job has ended, disappeared, or cannot complete its own
integration. It is not a bulk merge shortcut: every pull request is reconciled,
validated, reviewed, and merged separately.

## Scope and ownership

- Work only on the pull requests named or bounded by the maintainer. For a
  request to handle all non-draft pull requests, snapshot the open list and
  exclude drafts; recheck each candidate immediately before changing it.
- Keep each pull request's target branch. Factory implementation work normally
  targets `dev`; never retarget a pull request merely to make it mergeable.
- Treat explicit assignment as transfer of integration ownership for that
  pull request. Preserve the original author's intent and credit. Do not close a
  pull request just because its branch has conflicts.
- Do not merge a draft, an unvalidated change, a change with unresolved
  findings, or a pull request that adds a prohibited GitHub workflow.
- Never wait for, query, or cite GitHub Actions or status checks. Validation is
  performed locally using the repository's documented commands and receipts.

## Isolated repair

1. Inspect the current checkout and preserve all user changes. Do not clean,
   reset, stash, or overwrite unrelated work.
2. Use a dedicated local branch and temporary worktree for each pull request so
   its merge and validation cannot alter the user's active checkout or another
   repair. Confirm the target path is new and record the branch, worktree path,
   pull request number, head SHA, and base SHA.
3. Fetch the pull request head and its target branch. Confirm the pull request
   remains open and non-draft, and that its head SHA has not changed since
   inspection.
4. Merge the latest target branch into the pull request branch. Resolve each
   conflict by retaining the intent of both sides. In shared files such as
   `VERSION`, `CHANGELOG.md`, validation runners, lists, and registries, carry
   both sides' changes. For `VERSION`, use the higher bump, adding one only
   when both sides independently bumped it.
5. Do not use a blanket conflict strategy, discard target-branch work, or
   rewrite unrelated history. If intent cannot be reconciled without a major
   architectural decision, stop that pull request, list the conflicting paths
   and the unresolved decision, and continue with other independent assigned
   pull requests.

## Validation and review

1. Inspect the complete pull request diff against its target after conflict
   resolution. Confirm generated state, credentials, unrelated files, and
   prohibited `.github/workflows/*` files are not being introduced.
2. Run the required local validation from `docs/local-validation.md`, including
   the full Factory suite and YAML lint when applicable. Record the exact
   commands, result, and validated head SHA. Do not merge if validation fails.
3. Perform and record an independent technical review when another eligible
   maintainer is available. In a solo-maintainer repository, record a
   structured self-review covering scope, risk, important invariants,
   validation evidence, and unresolved findings. Resolve all blocking findings
   and repeat validation after any code change.
4. Push the repaired branch only after validation and review evidence are
   complete. Re-read the live pull request head and mergeability; they must
   match the validated commit and show no conflicts.
5. Merge one pull request at a time into its intended target. Confirm the merge
   completed and record the resulting target SHA before starting dependent work.
   Refresh the next pull request's base, diff, and conflicts after every merge.

## Cleanup and handoff

- After a pull request is merged or explicitly stopped, remove only the
  temporary worktree and local branch created for that pull request. Never
  remove pre-existing or automation-owned worktrees or branches.
- Verify the worktree and branch are gone, and confirm the user's original
  checkout and unrelated changes remain untouched.
- Report each pull request as merged or blocked, its target and resulting SHA,
  validation and review evidence, unresolved findings, and cleanup result.
