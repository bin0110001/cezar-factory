# Factory Workspace Lifecycle Management

**Status:** Proposed  
**Scope:** GitHub-driven coding agents operating inside Factory or independently on developer machines  
**Primary goal:** Prevent abandoned branches/worktrees and reduce repeated manual merges while preserving offline-first execution and reliable recovery.

## 1. Objectives

- [ ] Integrate validated agent work promptly rather than accumulating completed worktrees.
- [ ] Use one worktree lifecycle implementation regardless of whether an agent runs inside Factory or externally.
- [ ] Continue operating without Hindsight, Langfuse, GitHub connectivity, or a central Factory service when local work is possible.
- [ ] Recover safely from agent crashes, aborted sessions, host restarts, failed merges, and interrupted cleanup.
- [ ] Detect concurrent work on overlapping files without unnecessarily blocking progress.
- [ ] Preserve Factory's automatic `dev` workflow and human-reviewed promotion to `stable`.
- [ ] Keep orchestration deterministic where Git, database transactions, and CLI logic suffice; invoke LLMs for meaningful code-level repair, not routine Git bookkeeping.

## 2. Architecture and ownership

Two entry points share one **Workspace Lifecycle Core**:

```text
Factory-managed coding job                 External coding agent (Codex/Claude/etc.)
       |                                                 |
Factory execution adapter                  Conditional skill + native hooks
       |                                                 |
       +---------------------+---------------------------+
                             |
                factory workspace CLI / core
                             |
               Local SQLite registry + Git
                             |
       Claim -> Work -> Validate -> Queue -> Integrate -> Verify -> Cleanup
                             |
           Best-effort asynchronous event outbox
                             |
                    Hindsight / Langfuse
```

**Responsibility boundaries**

- **Factory scheduler/adapters:** launch agents, identify execution ownership, invoke lifecycle transitions, and renew leases independently of agent cooperation.
- **External agent skill/hooks:** discover and adopt local sessions, invoke the shared CLI only when the session is not Factory-managed, and guide external agents through completion/recovery.
- **Workspace Lifecycle Core:** authoritative local state, claims, lease/fencing enforcement, Git operations, validation policies, integration queue, reconciliation, and safe cleanup.
- **Agents:** implement and repair code; they do **not** directly declare merges successful or delete worktrees as a signal of completion.
- **Hindsight:** retrospective knowledge and recurring conflict patterns, never the live ownership source.
- **Langfuse:** run/merge/repair traces and operational metrics, never in the critical execution path.

- [ ] Implement lifecycle logic once in a shared local CLI/library, not separately in the Factory adapter and external skill.
- [ ] Make operations idempotent and resumable by run ID/issue ID.
- [ ] Ensure agents cannot silently bypass lifecycle requirements when invoked through supported adapters.

## 3. Local registry (SQLite + Git)

Store the operational registry in a per-host SQLite database on a **local filesystem**, not on a shared network mount. Git remains authoritative for branches, commits, and worktree existence; SQLite is authoritative for local claims and transitions. Use transactions, uniqueness constraints, a migration mechanism, and an append-only event log.

Suggested records:

| Entity | Essential fields |
|---|---|
| Repository | Repository identity, root, integration branch, validation policy |
| Work item | GitHub issue/project key, status, active execution ID |
| Execution | Run ID, adapter/source, owner ID, fencing token, created/updated timestamps, lease expiry, heartbeat |
| Workspace | Worktree path, branch, base commit, origin (`factory-created` or `adopted`), cleanup policy |
| Integration | Queue order, target branch, attempts, expected target HEAD, integrated commit, validation result, failure details |
| Event/outbox | Event ID, event type, timestamp, payload, per-destination delivery state |

- [ ] Define the schema and explicit lifecycle state machine (`claimed`, `working`, `validating`, `ready`, `integrating`, `blocked`, `integrated`, `cleanup_pending`, `closed`; plus recoverable/failed states).
- [ ] Add transactional single-active-owner claims per work item (with deliberate override/recovery paths).
- [ ] Add a per-repository integration mutex/lease enforced by fencing tokens.
- [ ] Track workspace ownership to distinguish disposable temporary worktrees from developer-adopted workspaces.
- [ ] Implement startup reconciliation against `git worktree list --porcelain`, actual refs, running processes, and registry records.
- [ ] Persist state transitions and outbox records transactionally where possible.
- [ ] Expose `status`, `list`, `inspect`, `doctor`, `recover`, and `prune` commands.

## 4. Execution context: Factory versus external

Factory launches managed agents with an explicit execution context, for example:

```bash
FACTORY_MANAGED=1
FACTORY_RUN_ID=run-abc123
FACTORY_ISSUE=456
FACTORY_WORKSPACE=/path/to/worktree
```

These values are **hints**, not proof. The CLI must verify the run ID and owner/fencing token against an active local registry record. A stale or partially populated environment must not accidentally disable workspace management.

| Context | Behavior |
|---|---|
| Valid Factory-managed run | Factory adapter owns lifecycle; companion skill is a no-op for lifecycle operations. |
| External run, no existing claim | Skill/hooks use CLI to claim or adopt work. |
| External run, existing local workspace/claim | Reuse or resume where safe rather than creating another worktree. |
| Missing/inconsistent context | Inspect local registry and Git; fail safely if ownership is ambiguous. |
| Central Factory or other services unavailable | Continue using local registry and Git; defer remote synchronization. |

- [ ] Build a deterministic, verified `factory workspace context` check.
- [ ] Make the external skill **activate only outside a verified Factory-managed execution**.
- [ ] Avoid relying on prompt/skill descriptions alone for conditional behavior.
- [ ] Ensure supported agent runtimes receive reliable initialization/completion handling through native hooks/wrappers where available.

## 5. Workspace lifecycle

### 5.1 Claim and prepare

- [ ] Identify repository, issue/work item, actor/run, current branch and working tree.
- [ ] Check for an already-active or recoverable workspace for the same issue.
- [ ] Resume existing work or explicitly report ownership conflicts instead of blindly creating a new worktree.
- [ ] Create an isolated issue branch/worktree only when needed.
- [ ] Support `factory workspace adopt --issue <id>` for developer-created worktrees.
- [ ] Never silently alter, reset, or remove dirty developer workspaces during adoption.
- [ ] Record base commit, worktree path, branch, origin, and intended integration target.

### 5.2 Work and validate

- [ ] Let agents work in their assigned workspace while the adapter maintains a heartbeat/lease independently.
- [ ] Run configured pre-integration checks (format/parse/build/tests as appropriate).
- [ ] Preserve failures and return actionable errors to the coding agent.
- [ ] Capture uncommitted changes safely before integration or block completion with explicit instructions; do not discard them.
- [ ] Mark work **ready for integration**, not complete, when the coding phase finishes.

### 5.3 Integration

- [ ] Serialize integration operations **per repository/target branch**, allowing coding work to continue concurrently.
- [ ] Recheck the integration target HEAD immediately before an attempt.
- [ ] Use deterministic Git operations to incorporate new baseline changes and detect conflicts (e.g., `git merge-tree` for applicable preflight checks).
- [ ] Perform merge/rebase only with a documented policy; preserve history/recovery refs until integration is proven successful.
- [ ] For conflicts, create a targeted repair task containing conflicting paths, commits, and diagnostic output.
- [ ] Requeue repaired work with a bounded retry policy and escalation path, not an infinite repair loop.
- [ ] Run **post-integration** validation against the combined tree; a clean Git merge alone is insufficient.
- [ ] Advance target branch atomically/with compare-and-swap protections against unexpected head changes.
- [ ] Record integrated commit(s) and successful validation evidence before declaring the issue integrated.

### 5.4 Finalization

- [ ] Update GitHub issue/PR state when available; queue remote updates offline otherwise.
- [ ] Delete Factory-created temporary worktrees/branches only after integration is proven successful and the cleanup target is safe.
- [ ] **Never automatically delete an adopted developer workspace**; leave it intact unless explicitly requested.
- [ ] Make cleanup idempotent so interrupted finalization can be retried.
- [ ] Retain sufficient event history and Git recovery references to diagnose a failed or incorrect integration.

## 6. Concurrency and overlap policy

Apply three levels of coordination:

1. **Issue ownership — hard constraint:** a single active run claims an issue unless an explicit transfer/recovery procedure succeeds.
2. **File overlap — advisory by default:** compare modified file paths across active worktrees and surface potential conflicts; do not globally lock files.
3. **Repository integration — hard constraint:** one integration transaction at a time per repository/target branch.

- [ ] Compute current changed-file sets from Git and flag overlapping active issues.
- [ ] Display overlap context to agents, scheduler, and UI.
- [ ] Prefer scheduling independent work together when practical, without blocking unrelated issues.
- [ ] Preserve existing progress and do not restart agents merely because another worktree edits a common file.
- [ ] Collect overlap/merge conflict statistics for later scheduling improvements.

## 7. Offline-first behavior and multi-machine boundaries

**Local mode:** A developer laptop/desktop maintains its own SQLite registry and local worktrees; lifecycle can operate with no Factory server connection.

**Connected mode:** When available, the external agent may report status to Factory's coordinator and request centralized integration. Remote ownership is not assumed to be globally synchronized while disconnected. **Do not synchronize SQLite files across machines.**

Important distinction: offline work can proceed, but two disconnected hosts cannot provide a globally exclusive claim for the same GitHub issue. On reconnection, reconcile divergent branches and ownership before integrating into a shared remote target. Never claim cross-machine locking guarantees in offline mode.

- [ ] Implement fully functional local mode without external network services.
- [ ] Implement optional coordinator registration/status for connected machines.
- [ ] Define reconciliation rules for same-issue work produced independently on two machines.
- [ ] Queue remote status/GitHub updates for retry; keep local code commits durable.
- [ ] Prevent blind remote target updates after prolonged disconnection; refresh/revalidate before integration or pushing.

## 8. Reliability and recovery

| Scenario | Required response |
|---|---|
| Agent process crashes | Expire/recover ownership after verifying liveness; keep changes. |
| Factory process/host restarts | Reconcile Git worktrees and registry; resume valid work and integration attempts. |
| Agent finishes but work is uncommitted | Save safely or block integration with instructions; never discard. |
| Hindsight or Langfuse is down | Continue normally; retain telemetry in local outbox. |
| GitHub is unavailable | Continue local work; defer status updates/remote operations. |
| Merge conflict | Route focused repair back to an agent with diagnostics. |
| Merge passes but tests fail | Do not publish/promote failed combined tree; preserve repairable state. |
| Lease expires but old process later resumes | Use fencing/ownership verification to reject stale mutations. |
| Worktree is missing | Recover from surviving Git refs where possible; otherwise flag for attention. |
| Merge succeeded, cleanup interrupted | Reconcile known integration commit and finish safe cleanup. |

- [ ] Distinguish a stale lease from proof that a workspace is disposable.
- [ ] Add process liveness checks and fencing tokens for stale owners.
- [ ] Persist recoverable intermediate states around potentially irreversible Git operations.
- [ ] Define protection against losing unpushed commits and uncommitted changes.
- [ ] Add crash/restart and interrupted-integration test coverage.
- [ ] Provide operator overrides with audit events rather than hidden automatic destructive behavior.

## 9. External-agent companion skill and integrations

Name: **`factory-workspace`**. Its purpose is to bridge independently launched coding agents into the same local lifecycle protocol.

The skill should describe when and how to:

- [ ] Check `factory workspace context` before any lifecycle action.
- [ ] Exit without managing work when Factory-managed ownership is verified.
- [ ] Discover the current repository and issue (or request/derive one when necessary).
- [ ] Reuse, resume, or adopt an existing workspace before considering a new worktree.
- [ ] Claim work via the shared CLI and handle ownership conflicts.
- [ ] Finish by initiating validation/integration rather than deleting local state.
- [ ] Invoke recover/inspect commands after interrupted work.

**Supporting enforcement:**

- [ ] Add concise persistent instructions to repository `AGENTS.md` for compatible agents.
- [ ] Supply native hooks or wrapper entry points for supported Codex and Claude Code versions, subject to their actual capabilities.
- [ ] Keep agent-specific adapters thin; avoid duplicating core Git/SQLite logic inside skills.
- [ ] Test that the skill is inert inside Factory and effective outside it.
- [ ] Test adoption behavior for dirty or pre-existing developer worktrees.

**Illustrative commands** (final CLI names/interface to be confirmed during implementation):

```bash
factory workspace context
factory workspace claim --issue 456
factory workspace adopt --issue 456
factory workspace status
factory workspace finish --issue 456
factory workspace recover
```

## 10. Branching and promotion policy

Default recommendation: integrate validated work promptly into **`dev`** (or the repository's configured development target), avoiding a growing queue of completed-but-unmerged branches. Preserve the existing **human-reviewed promotion to `stable`**.

An optional `factory/integration` branch may be configured for repositories needing batched staging; it should not be a mandatory extra queue.

- [ ] Make integration target configurable per repository.
- [ ] Support immediate automatic integration to `dev` after validation.
- [ ] Support optional staging/integration branches without requiring them everywhere.
- [ ] Respect existing stable-channel approval/promotion controls.
- [ ] Ensure completed issues reach a terminal state only after verified integration and durable bookkeeping.

## 11. Observability and UI

- [ ] Add UI for active workspaces, ownership, issue, branch, age, heartbeat, and host.
- [ ] Display integration queue, attempts, blocked items, conflicts, and cleanup-pending work.
- [ ] Surface changed-file overlap and current integration target.
- [ ] Provide resume/retry/recover actions with permission checks and audit records.
- [ ] Record metrics: abandoned worktrees, time-to-integration, merge conflict rate, auto-repair success, test failures, manual interventions, and cleanup backlog.
- [ ] Publish events to Langfuse asynchronously through a local outbox.
- [ ] Publish recurring lessons/error patterns to Hindsight asynchronously.
- [ ] Keep all monitoring integrations optional for local operation.

## 12. Delivery phases

### Phase 1 — Core and external-agent readiness (MVP)

- [ ] Implement local SQLite registry, transaction-safe claims, run identity, and state transitions.
- [ ] Build shared `factory workspace` CLI, Git worktree discovery, and safe resume/adopt commands.
- [ ] Implement Factory-managed execution detection and adapter integration.
- [ ] Ship external `factory-workspace` skill plus initial supported agent hooks/wrappers **in the same phase**.
- [ ] Implement basic validation → serialized integration → post-merge verification → safe cleanup.
- [ ] Implement startup reconciliation, bounded retries, and no-destructive-cleanup safeguards.
- [ ] Document local/offline operation and the limits of cross-machine ownership guarantees.

**MVP acceptance criteria**

- [ ] A Factory-run agent and an external agent use the same lifecycle core with no duplicated logic.
- [ ] Factory-managed agents do not trigger the external skill's lifecycle path.
- [ ] An external agent can adopt an existing worktree without creating an unnecessary new branch.
- [ ] Sequentially completed overlapping issues integrate automatically or produce recoverable targeted conflicts; no forgotten finished worktrees.
- [ ] Crashing mid-run/mid-integration never silently deletes unmerged changes.
- [ ] Failure of Hindsight, Langfuse, or Factory's central services does not stop local execution.
- [ ] Factory-created worktrees clean up after verified integration; adopted developer workspaces remain intact.

### Phase 2 — Conflict repair and scheduling awareness

- [ ] Implement Git preflight and targeted agent conflict-repair jobs.
- [ ] Add change-overlap detection and advisory scheduling hints.
- [ ] Add repair retry budgets, escalation, and historical conflict categorization.
- [ ] Harden multi-machine reconnection and divergent-work reconciliation.

### Phase 3 — Operator experience and observability

- [ ] Implement dashboard views for workspaces, queue, blocked work, and recovery.
- [ ] Add richer Hindsight and Langfuse event sinks.
- [ ] Add run-to-merge analytics and conflict trend reports.
- [ ] Add operational maintenance tooling and retention policies.

## 13. Explicit non-goals for initial implementation

- [ ] **Do not** add Redis, Kubernetes, distributed locks, or an always-on coordination service for local operations.
- [ ] **Do not** use Hindsight or Langfuse as the ownership source.
- [ ] **Do not** rely on an LLM to perform routine registry operations, choose deterministic context, or decide whether a Git merge is clean.
- [ ] **Do not** automatically lock files or stop all development because two issues touch the same path.
- [ ] **Do not** claim globally exclusive cross-machine issue ownership while disconnected.
- [ ] **Do not** delete adopted developer workspaces automatically.
- [ ] **Do not** require GitHub Actions compute; validation and orchestration run on local/owned compute.

## 14. Open implementation decisions

- [ ] Choose language/package/distribution strategy for the workspace CLI within the Factory repository.
- [ ] Define the repository-specific validation command contract and acceptable failure baseline (important for repositories with existing test/parse failures).
- [ ] Choose merge versus rebase policy, commit attribution, and how to preserve PR review semantics.
- [ ] Define how external agents identify a work item when launched without a GitHub issue.
- [ ] Define connected-mode coordinator transport/authentication if cross-host orchestration is introduced.
- [ ] Specify which supported agent versions offer reliable session-start/session-end hooks and where a wrapper is required.

---

**Guiding rule:** *Coding is not complete until the code is integrated and validated. Agents write code; the Workspace Lifecycle Core owns worktrees, integration, recovery, and cleanup.*
