# Factory contributor instructions

For every change that modifies a Factory-managed asset (including `scripts/`,
`skills/`, `workflows/`, `policies/`, `templates/`, `automations/`, or Factory
versioning), work in Dev mode by default: validate the change, commit it, and
push it through a reviewed PR to `dev`. Do not run production synchronization,
stable promotion, or Bazzite deployment unless the user explicitly requests a
**Production Run** or explicitly asks for a live production deployment. Dev
troubleshooting must continue when production-only target configuration or
host parity is unavailable; report production release as pending only when
relevant.

All validation runs on our own compute; nothing runs on GitHub. There is no hosted
CI: never add or restore `.github/workflows/*`, never trigger, wait on, poll, or
cite GitHub Actions or status checks (`gh pr checks`, `gh run ...`), and never treat
"no GitHub checks" as a blocker or a reason to wait. Validation is the local suite
(`tests/run-tests.ps1`, the `.githooks` pre-commit hook, `scripts/factory/test-changed.ps1`,
and the `promote-stable.ps1` gate), and its receipts are the validation evidence for
review and auto-merge (see `docs/local-validation.md`). If a GitHub workflow runs
anyway, it is a stray left on another branch or in repository settings: report it and
remove it; do not wait for it or work around it.

Workflows own scripts. Every Factory script runs from a `command:` step in
`workflows/*.yaml`; skills and workflow `prompt:` text must never instruct the
model to run a Factory script, extract an issue number for one (pass `-Task
"{{task}}"`), or discover work the workflow already selected. An agent asked to
run an automation queues it (`cez automation run <id>`) and reports the task ID;
it does not inspect that automation's worktree or create replacement tasks.
`tests/run-tests.ps1` enforces the script rule.

For coding sessions outside a verified Factory workflow, use the
`factory-workspace` skill. In a local interactive dev window, when the user
directs work in the current checkout, a `cez workspace` claim/adoption and
host-local registry access are not required. First verify that this is not a
Factory-managed run, inspect the current branch and worktree, and preserve all
unrelated changes; stage only files for the requested issue. If the session is
running on the Cezar runner, or its execution context is unclear, use the
`cez workspace` CLI to claim or adopt local work as described by the skill.
For local interactive development, use the one existing checkout; do not create
or switch to another Git worktree or temporary clone unless the user directly
asks for one. Use a fresh task branch in that checkout by default. After a task's
PR is confirmed merged into `dev`, update `origin/dev` and create the next task
branch from it before starting unrelated work; do not keep stacking unrelated
tasks on the merged branch. This normal branch rollover does not require a
separate user request. Preserve unrelated local changes and stage only files for
the requested issue. If a dirty change would be lost or carried into the next
task, preserve it safely or report the mismatch before switching. If the
requested task otherwise does not fit the current checkout, preserve it and
report the mismatch instead of silently moving the work elsewhere. This local
one-checkout rule does not authorize managing or cleaning up worktrees created
by Cezar automation; treat those as automation state and leave them alone unless
the user asks for cleanup.
The Cezar scheduler verifies Factory run identity and fencing data before
setting `FACTORY_MANAGED=1`; a marker by itself is never trusted. Do not add
Factory scripts to agent-facing skill instructions.

When asked to complete outstanding issues, work the repository backlog
autonomously. Select the next eligible issue from the existing queue using its
readiness, dependencies, priority, and age; do not wait for the user to schedule
each issue or approve routine assumptions. Decomposed children enter planning
automatically and continue in dependency order. If one issue is waiting on
independent technical review, or release, continue with other eligible issues
instead of pausing the whole backlog. Ask the user only to decide a major
architectural choice that materially changes compatibility, ownership, or the
system contract. Resolve routine ambiguity with the safest reversible
assumption and record it. User review is post-delivery feedback; if the user
later finds a defect, they will file a follow-up issue.

Invoke `factory-finish-release` only for a **Production Run** or an explicit
request to deploy live. It orchestrates configured-target synchronization,
Bazzite checkout and Cezar runtime parity checks, and production promotion. In
that mode it must stop on failed validation, missing target configuration,
dirty or mismatched remote checkouts, or missing review gates rather than
overwriting state. These production gates do not block ordinary Dev-mode work.

Promotion is automatic and has one owner: the Bazzite host's `factory-local-promotion` timer
(`docs/promotion-pipeline.md`). After a change merges to `dev` it validates the exact SHA with the
full local suite, activates the `dev` channel, runs canary jobs against it, and only then
fast-forwards `origin/stable` and deploys it; a failed canary rolls `dev` back, quarantines the SHA,
opens an issue, and counts toward a circuit breaker. Do not run promotion by hand, set a channel
pointer, or wait on a promotion: merge to `dev` with a recorded self-review and read the result
with `.claude/ship/ship-loop.ps1 -Action Deploy` (a thin client) or `factory_local_scheduler.py status`.
The posture is data in `config/promotion-policy.json`: `autonomous` (self-review plus passing
validation is enough) is the default, and `controlled` adds an independent approval, a soak
period, and explicit approval before `stable` moves. A **Production Run** selects `controlled`;
it is a config change, not a different process. `scripts/release/promote-stable.ps1` remains as
the break-glass manual path for a Production Run or a dead promoter; it runs the full suite and
only then fast-forwards `origin/stable`. The `factory-autodeploy` timer reconciles the host to
`stable`. Never promote or deploy an untested commit, and never edit the Bazzite checkout by hand.

The shared Factory checkout mounted into Cezar is the default source of
workflows, skills, policies, and runtime scripts. Read Cezar targets only from
the host-local `config/factory-projects.json`; `apiUrl` and `projectId` identify
each remote project. A target with `mode: shared` receives automation
synchronization only and must never receive managed-file pushes.

The legacy `push-factory-updates.ps1` path is deprecated. Keep it until a
complete shadow-audit receipt reports `legacyPushRetirementReady: true` for
every registered target. If a workflow uses that compatibility path, its
configured controller and autodeploy locks must be the same host lock files
used by the release services and must stay held for the whole operation.

Use a local `projectPath` only as a fallback when a project needs the full
`.ai/factory` installation (workflows, skills, policies, scripts, or pinning).
It must be an absolute, verified path on the workflow host. The shadow audit
reads only registered local paths; remote-only targets remain `unknown` and
must not be discovered by scanning.

Remote-only synchronization does not deploy application or infrastructure
files from `integrations/`. For Bazzite-hosted services, use the explicit
deployment inventory in `config/server-topology.env` and run the supported
deployment script from the Bazzite Factory checkout. In particular, LiteLLM
uses its host-local bind-mounted config and must be redeployed/restarted after
changes to `integrations/bazzite/litellm-config.yaml`.

When a project needs the full Factory layer, add an absolute, verified local
`projectPath` to its registry entry; the owning workflow performs the
applicable read-only plan before any mutation. Do not put a remote container
path in `projectPath`; it is resolved on the workflow host. If the checkout is
only on Bazzite, record its remote checkout and service-config paths in the
deployment inventory/operations notes and use the host deployment flow.

For a Production Run, targets must be listed in the host-local
`config/factory-projects.json` file or explicitly supplied by the user. Do not
scan drives for targets or deploy to an unlisted project. If no target registry
exists, make no production changes and report that the release is ready but
needs target configuration. This does not prevent Dev-mode commits, PRs, or
development-channel updates.

After an update passes validation, the implementation PR must target `dev` and
request GitHub auto-merge. This applies to every approved risk level. High risk
alone is not a reason to stop for user approval; request input only when the
plan exposes a major architectural decision.

When the change fixes broken code (a failing deploy, test, workflow, or runtime, or a
regression), merge the PR yourself once local validation has passed and the
self-review is recorded: `gh pr merge <number> --squash`. Do not use `--auto` or
wait for GitHub auto-merge; this repository has no branch rules on `dev`, so GitHub
rejects it ("Protected branch rules not configured"). Before merging, confirm the PR
head is your pushed, validated commit (`gh pr view <number> --json headRefOid`), and
that `gh pr view <number> --json mergeable,mergeStateStatus` is `MERGEABLE`/`CLEAN`.
After merging, confirm the fix is on `origin/dev` (grep for the changed line) before
promoting or deploying; never assume a PR merged someone else's earlier snapshot of
your branch. If the merge is refused or conflicts, resolve it and re-validate rather
than bypassing a gate. Runs outside Dev mode still follow the production-release gates
above.

**A job owns its pull request until it merges.** The job that opens or updates a PR
(implement, fix) is responsible for getting it to `dev`; the user is never the one who
rebases or resolves conflicts for it. Before handing off, the job merges the current
`origin/dev` into its branch, resolves every conflict itself, re-runs its validation on the
merged result, and leaves the PR `MERGEABLE` (`gh pr view <n> --json mergeable` is
`MERGEABLE`). Resolve a conflict by keeping the intent of both sides: shared hot files
(`VERSION`, `CHANGELOG.md`, `tests/run-tests.ps1`, lists and registries) take both changes,
and `VERSION` takes the higher of the two bumps plus one only if both sides bumped it.
Never discard the other side's work to make a conflict disappear, never close a conflicting
PR to avoid the work, and never leave a conflicting PR waiting for a human. If `dev` moves
while a PR waits for review and it becomes `CONFLICTING`, repairing it is again the owning
job's work (the fix automation on that issue), followed by the same validation. A PR that
cannot be reconciled without a major architectural decision is the only case that goes to
`factory:needs-help`, with the conflicting paths listed in the issue comment.

Use an independent technical reviewer when another eligible maintainer is
available. In a solo-maintainer repository, the author must instead record a
structured self-review on the PR covering scope, risk, important invariants,
validation evidence, and any unresolved findings. The self-review satisfies
the review gate only when validation has passed and no findings remain
unresolved. Do not merge or request auto-merge for a failed, unreviewed, or
unresolved PR. User review is not a required gate.

Keep the issue's stage visible (see `docs/lifecycle.md`, "Where is my issue?"). When you
start work on an issue in a dev window, replace its `factory:*` state label with
`factory:working` and add `factory:interactive` so stale-work sweeps leave it alone. When
the work is finished and pushed but has no PR yet, replace the state with
`factory:implemented`. Open the PR into `dev` with a closing keyword (`Closes #N`) in its
body for every issue it fully delivers; the `factory-maintenance` workflow then marks the issue
`factory:pr-open` and, after the merge, closes it with `factory:done`. GitHub itself does not
close issues on merges to `dev`, so a missing closing keyword leaves the issue open. Leave
`factory:tracking` epics to be closed by hand.
When you finish making changes, commit them and push the branch to its remote
before reporting the work as done. Never leave finished work only in the local
checkout. Stage only the files that belong to the change (leave unrelated
untracked files such as `.factory/release-reports/` alone), and push only after
validation has passed.

Run authenticated GitHub CLI commands (`gh`) outside the sandbox so they can
use the host's existing GitHub credential from the Windows keyring. Do not run
`gh auth login` or replace credentials unless the host credential is actually
invalid.
