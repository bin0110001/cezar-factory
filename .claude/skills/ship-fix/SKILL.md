---
name: ship-fix
description: After fixing an issue locally, push the fix, open the PR to dev, deploy, and re-run the Factory workflow to verify the fix works, retrying with further fixes within a budget. Use when the user says to ship, push and verify, or close the loop on a fix.
---

# Ship a fix and verify it

Goal: the issue's original failure no longer reproduces when the **same Factory workflow is re-run**
on the deployed fix. Multiple deploy attempts are allowed to reach that goal without asking the user to
verify by hand. Settings (project, base branch, attempt budget, default verify automation) live in
`.claude/ship/ship-loop.json`; resolve them with
`pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Config`.

## Loop

0. **Promotion health.** Run `pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Health` first. Exit 4 /
   `SHIP_HEALTH_WARN` means candidates keep failing on the host, so a merge will not deploy: say so to the user,
   and diagnose with `-Action Validate` (below) instead of merging more work on top.
1. **Context.** Follow `factory-workspace`: confirm `FACTORY_MANAGED` is absent, inspect the branch and
   worktree, preserve unrelated changes (e.g. `.factory/release-reports/`). Identify the issue number and
   the Factory workflow/automation whose failure the issue describes (the issue body or failure-audit
   evidence names it). If you cannot tell, ask once.
2. **Push (automatic, no confirmation).** Run the project's tests for the change (for Factory assets:
   `pwsh -NoProfile -File scripts/factory/test-changed.ps1`). On pass: stage only the issue's files, commit
   (reference the issue), `git push -u origin HEAD`. On failure: fix it and rerun; do not push red.
3. **PR.** Open (or reuse) a PR into the configured base branch with `Closes #N`, add a structured
   self-review (scope, risk, invariants, validation evidence, unresolved findings), and set the issue label to
   `factory:implemented`/`factory:pr-open` per `AGENTS.md`. Run `gh` outside the sandbox.
4. **Validate on Linux, then merge and deploy.** The suite passes on Windows and can still fail in the Linux
   promotion container. Before merging, run `pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Validate`
   (the PR head must be pushed); it runs the host's own full suite and prints `VALIDATE_FAIL` lines. Do not
   merge on `VALIDATE_FAILED`: fix it, push, and validate again. For a fix to broken code, merge the PR yourself (`gh pr merge <n> --squash`; never
   `--auto`, GitHub rejects it here): first confirm the PR head is your pushed, validated commit and the PR is
   `MERGEABLE`/`CLEAN`, then after merging confirm the fix is on `origin/dev` (grep for the changed line). Never
   wait on or poll GitHub Actions/status checks: there is no hosted CI, and local test results are the validation.
   Then use `ship-deploy`.
5. **Verify.** Use `ship-verify` to queue the same workflow, then `ship-status` with `-Wait` to follow it.
6. **Decide.**
   - Passed: comment on the issue with attempt count, SHA and run id; stop.
   - Failed: read the run's failure through the run API history (not the worktree), diagnose, make a new fix
     on the same branch or a follow-up PR, and go back to step 2. Each Verify consumes one attempt.
   - Budget exhausted (exit 3) or deploy blocked (exit 4): stop and report exactly what happened. Do not
     raise the budget or touch the Bazzite checkout yourself.

## Rules

- Never promote by hand or bypass the host promoter (`docs/promotion-pipeline.md`); `ship-deploy` only watches it. The PR body must carry a `## Self-review` section or the promoter blocks the merge as lacking evidence.
- Do not create replacement tasks or inspect the automation's worktree to "do the work"; the workflow is the work.
- Only one project is configured today; to extend, add an entry to `ship-loop.json`.
- End with a handoff: issue, PR, deployed SHA, each attempt (run id, outcome), final status.
