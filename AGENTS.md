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
For local interactive development, use the one existing checkout. Do not create
or switch to another Git worktree, temporary clone, or task branch unless the
user directly asks for one. If the requested task does not fit the current
checkout, preserve it and report the mismatch instead of silently moving the
work elsewhere. This local one-checkout rule does not authorize managing or
cleaning up worktrees created by Cezar automation; treat those as automation
state and leave them alone unless the user asks for cleanup.
The Cezar scheduler verifies Factory run identity and fencing data before
setting `FACTORY_MANAGED=1`; a marker by itself is never trusted. Do not add
Factory scripts to agent-facing skill instructions.

When asked to complete outstanding issues, work the repository backlog
autonomously. Select the next eligible issue from the existing queue using its
readiness, dependencies, priority, and age; do not wait for the user to schedule
each issue or approve routine assumptions. Decomposed children enter planning
automatically and continue in dependency order. If one issue is waiting on CI,
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

Factory content reaches Cezar through the shared mount (`docs/shared-factory.md`): after a change
is merged to `dev`, it is available to the development channel. Run
`scripts/release/promote-stable.ps1` only during a Production Run; it runs the
full test suite and only then fast-forwards `origin/stable`. The Bazzite host's
`factory-autodeploy` timer fast-forwards the mounted checkout to `stable` and
reconciles automations. Never promote or deploy an untested commit, and never
edit the Bazzite checkout by hand.

The legacy per-project release pipeline is remote-only Cezar synchronization: read
`apiUrl` and `projectId` from `config/factory-projects.json` and synchronize
the Factory checkout's automation definitions directly to each Cezar project.
Use a local `projectPath` only as a fallback when a project must receive the
full `.ai/factory` installation (workflows, skills, policies, scripts, or
project pinning).

Remote-only synchronization does not deploy application or infrastructure
files from `integrations/`. For Bazzite-hosted services, use the explicit
deployment inventory in `config/server-topology.env` and run the supported
deployment script from the Bazzite Factory checkout. In particular, LiteLLM
uses its host-local bind-mounted config and must be redeployed/restarted after
changes to `integrations/bazzite/litellm-config.yaml`.

When a project needs the full Factory layer, add an absolute, verified local
`projectPath` to its registry entry and run a dry run first. Do not put a
remote container path in `projectPath`; the release script resolves that path
on the Windows host. If the checkout is only on Bazzite, record its remote
checkout and service-config paths in the deployment inventory/operations notes
and use the host deployment flow instead.

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
