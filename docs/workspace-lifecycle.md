# Workspace lifecycle core

`cez workspace` is the shared local lifecycle entry point for Cezar's own
Factory workflow adapter and external coding sessions. It stores claims,
executions, workspaces, leases, fencing tokens, state transitions, and audit
events in a SQLite database under `~/.cezar/workspace-lifecycle/`. Set
`CEZ_HOME` to a host-local directory in tests or containers. Do not put this
database on a shared mount or synchronize it between machines.

Git remains authoritative for commit, branch, and worktree existence. The
registry is authoritative for issue ownership and lifecycle transitions. Claim
and state changes use SQLite transactions; only one active execution can own an
issue per repository. Every new execution receives a monotonically increasing
fencing token. A heartbeat or state change with an old token or expired lease is
rejected.

## Commands

```text
cez workspace context
cez workspace claim --issue 456 [--base dev]
cez workspace adopt --issue 456
cez workspace validate --issue 456
cez workspace integrate --issue 456 --pr <number-or-url>
cez workspace reconcile                retry merged PR integration and remote status updates
cez workspace status [--issue 456]
cez workspace list
cez workspace inspect --issue 456        include recent audit and preflight events
cez workspace preflight --issue 456 [--json]
cez workspace overlaps
cez workspace doctor
cez workspace recover --issue 456 [--force]
cez workspace resume --issue 456          resume a blocked execution under its current owner
cez workspace prune --issue 456
```

`claim` creates or reuses `.ai/cezar/workspaces/issue-<id>` on
`factory/issue-<id>`. It refuses to overwrite an existing unregistered path or
claim owned by another execution. `adopt` records a currently registered Git
worktree as developer-owned and does not modify its contents. Dirty workspaces
are allowed for adoption and block later cleanup.

Validation is repository-specific and has no implicit test-command guess. Add
a tracked `workspace-lifecycle.json` at the repository root (or use
`.cezar/workspace-lifecycle.json` / `.ai/cezar/workspace-lifecycle.json`) with
`validation` as one argv array or an ordered array of argv arrays. The commands
run directly without a shell. A passing sequence moves `validating` to `ready`;
the Git worktree must also be clean. Any failed command or uncommitted file
returns the issue to `working` and keeps all files intact. Factory handoff
applies the same clean-worktree gate.

The Cezar scheduler registers only the Factory implementation, review, and
review-fix workflows, and only when an explicit issue reference was selected
for the run. Planning, intake, investigation, and project-maintenance workflows
do not take workspace ownership, so they cannot strand a claim before the next
coding phase. A terminal failed coding run can transfer its claim to a retry
under a higher fence; the previous worktree is preserved as recoverable history.
The scheduler injects
`FACTORY_MANAGED`, run ID, issue, workspace, owner, and fencing token into
agent/check processes. `cez workspace context` verifies those values against
the local active registry row, so a marker alone never suppresses external
lifecycle handling. The scheduler renews the lease independently of agent turns.
After a validated coding phase, the Factory workflow records `ready` before
handing the issue to review. A later Factory phase can transfer a `ready` claim
only after Cezar confirms its previous run is terminal.

At Cezar startup, the adapter reconciles registered Git worktrees and retries
cleanup only for clean, Factory-created workspaces already in `cleanup_pending`.
An `integrated` row remains as a durable remote-status retry record until the
GitHub issue update succeeds. Missing trees,
expired leases, dirty workspaces, and adopted workspaces are reported for an
operator; startup does not reset branches or discard files. `overlaps` compares
committed, staged, unstaged, and untracked paths across active issue workspaces.
It is advisory and never prevents concurrent coding.

`preflight` runs Git's `merge-tree` against the newest locally available `origin/<target>`
(falling back to the local target branch; configured by `targetBranch`, default `dev`)
and the registered issue branch without changing either branch or the worktree. A
conflict prints structured JSON and exits with status 2. Factory coding workflows use
that output for one bounded repair retry before the issue is handed to review. Its JSON
output contains both commit IDs, conflicting
paths, full Git diagnostics, shared-path overlap context, and a `repairContext` object
that can drive a targeted repair run. Conflict results are persisted in the local
event log and visible through `inspect`. Preflight uses the target ref currently
available locally; fetch and inspect the target again before attempting integration.

The Cezar cockpit adds a **Workspaces** dashboard view across registered projects.
It shows active issue claims, branches, owner/fencing token, lease expiry, cleanup
states, and advisory changed-path overlap pairs. It refreshes periodically and is
backed by local metrics for expired leases, cleanup backlog, preflight conflict rate,
validation failures, manual recoveries, and average time to verified integration.
Metrics cover the last 30 days of local event history, including categorized preflight
conflicts, bounded repair outcomes, and telemetry backlog; absent samples are shown as
no data. The dashboard offers confirmed validation retry, blocked-work resume, safe
lease recovery, and verified cleanup retry actions; mutations are disabled in hosted
`CEZ_REMOTE` mode.

## Local and connected boundaries

No GitHub API, Factory coordinator, Hindsight, or Langfuse connection is needed
for local claims, adoption, validation, status, or recovery. The SQLite registry
is local to one host: it cannot provide cross-machine exclusion while machines
are disconnected. Refresh and reconcile remote branches before integrating
after offline work. If two hosts independently work the same issue, compare their
branches and worktree changes explicitly before publishing either result; the local
registry does not automatically reconcile two divergent issue branches. No
cross-host coordinator or offline GitHub-status queue is configured by this release.

Validation runs exactly the repository's configured commands. Those commands
may require their own package registries or other dependencies; the lifecycle
core itself does not contact GitHub or a central Factory service during local
claim, status, recovery, or validation state changes.

The `integrate` command requires GitHub to report the PR merged, checks that the
PR head equals the recorded worktree branch and the merge commit is reachable
from the configured target (default `dev`), then validates that combined commit
in a detached temporary worktree. It holds a repository/target integration lock
and renews execution and lock leases during validation. A failed check returns
the issue to `ready` and keeps its workspace. Cleanup remains unavailable until
post-integration validation passes and the lifecycle reaches `cleanup_pending`.
Adopted developer workspaces are never automatically deleted.

While Cezar is running, each project manager checks ready lifecycle claims once
per minute for a merged PR whose head exactly matches the recorded workspace
branch and whose base matches the configured target. A match runs the same
verified integration path automatically. GitHub lookup failures and missing
merged PRs leave the claim ready for a later sweep. After post-integration
validation succeeds, Cezar updates the issue's `factory:done` state and only then
cleans a Factory-created workspace. If the GitHub issue update fails, the row
stays `integrated` and the workspace stays present; later sweeps retry the
bookkeeping before cleanup. Review routing therefore leaves a managed issue in
`factory:review` until this lifecycle check finishes.
Post-integration validation gets at most three automatic attempts per execution.
After the third failure the claim moves to `blocked`, the worktree and diagnostics
remain available, and the minute sweep stops retrying it for operator repair.

## Native agent hooks

Optional hook fragments for Codex and Claude Code are in
`integrations/agents/workspace-lifecycle/`. Merge the relevant fragment into
the agent's user or project configuration and keep `cez` on `PATH`. Both hooks
call `cez workspace hook-context`, which verifies Factory ownership and returns
brief start/stop context. Factory-managed runs are explicitly yielded to; an
unverifiable `FACTORY_MANAGED=1` marker instructs the agent to stop for operator
recovery. The hooks provide guidance and completion reminders; lifecycle state
changes remain enforced by the CLI and Factory adapter.

Codex loads hook sources only after they are reviewed and trusted. Claude Code
hooks are configured in JSON settings. The fragments are opt-in and do not
modify a user's existing agent configuration.

## Telemetry outbox

Lifecycle events and configured sink rows are committed in the same SQLite
transaction. `cez workspace outbox` shows delivery counts, and
`cez workspace outbox --drain` sends coarse event spans to Langfuse's OTLP/HTTP
endpoint when `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, and
`LANGFUSE_SECRET_KEY` are set. Delivery errors are recorded locally and do not
change workspace ownership or state. Event payloads and local paths are not
exported. Retries use exponential backoff and stop after 12 attempts. With
Hindsight configured, only a successfully repaired conflict creates a lesson
candidate row. Inspect its event ID with `cez workspace outbox`, review the
curated lesson, then explicitly approve it with
`cez workspace outbox --approve-hindsight <event-id>`. The background drain
publishes approved lessons to the configured project bank; failures stay local
for retry. After correcting a sink configuration, requeue an exhausted delivery
with `cez workspace outbox --retry <event-id> --destination <langfuse|hindsight>`.
