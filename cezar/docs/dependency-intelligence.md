# Dependency Intelligence

Dependency Intelligence is a local-first projection of GitHub issues, native issue dependencies, and Factory decision records. GitHub remains authoritative for issues and native dependency links. The local graph is versioned so analysis can continue offline and can explain which source revision produced a result.

## v1 graph contract

The TypeScript/Zod source of truth is `packages/contract/src/dependency-graph.ts`. It exports node, edge, decision, snapshot, and JSON Schema contracts. Every node identifier includes its repository, for example `issue:github.com/owner/repo:123` or `decision:github.com/owner/repo:8d68f1a2`. Nodes and edges carry their source revision and observation time.

Edges point from prerequisite to dependent. Thus `A BLOCKS B` means A must be complete before B can start. `PART_OF`, `RELATED_TO`, `INFORMS`, `SUPERSEDES`, and `CONFLICTS` are descriptive relations and do not gate work. A model-origin edge can never be verified. Scheduler admission may consult only `BLOCKS` edges whose authority is verified; proposed and uncertain edges remain visible for review.

Decision records retain question, options, rationale, evidence links, affected nodes, reversibility, owner, required authorization, state, actor, timestamps, and revision. Proposals are read-only until reviewed. High-impact decisions and structural dependency changes require human approval.

## Source and freshness rules

- Native GitHub dependency links are verified only after reading them from GitHub.
- Machine suggestions and issue prose do not create hard blockers. Explicit machine-readable metadata must be validated and authorized before it becomes verified.
- Offline or stale projections remain queryable and always carry a freshness status. Unknown freshness is not equivalent to ready.
- A graph snapshot is immutable for analysis and replay. Reconciliation updates the projection and creates a new revision; it does not rewrite an older snapshot.
- Cross-repository references use fully qualified node IDs. Access failures are surfaced as unavailable/unknown data rather than empty dependency lists.

## Decision lifecycle

Allowed transitions are defined in the contract helper `canTransitionDecisionState`: proposed decisions may be approved or rejected; approved decisions may be resolved, deferred, or rejected; resolved/deferred decisions may be reopened or superseded; superseded decisions are terminal; rejected decisions may be reopened. Every write must compare the caller's expected revision before mutation.

## Current local surface

Project routes under `/api/v1/p/:projectId/` provide bounded snapshot pages and diffs, node detail and impact, bounded neighborhood expansion, readiness and cycle diagnoses, repair candidates with operator approval/apply/reject/rollback actions, health counts, decision ranking and candidate discovery, recent event history, weekly historical trends, sanitized diagnostics export, proposal creation and review transitions, counterfactual simulation, and explicit GitHub synchronization. Snapshot pages support server-side title/ID, repository, kind, state, and readiness filters and can pin a requested immutable revision. Synchronization starts only on `POST .../dependency-graph/sync`; read routes use the cached graph and mark data stale after 24 hours. Decision proposal writes use graph revision compare-and-swap and cannot approve themselves. Proposed agent records can be edited; the local operator can create proposals that require human approval. State transitions also require the current graph revision; operator approval transitions are served only on the local operator surface and are recorded in the audit log. Simulation accepts at most 100 edge additions/removals and 100 issue/decision outcomes, pins the requested immutable revision, cannot assert a new verified blocker, and reports `persisted: false`. It returns whole-graph readiness and cycle deltas, with detailed changes capped at 200 readiness rows and 50 cycles. The shareable scenario export omits issue content and edge provenance/evidence. Critical path remains unavailable until the source projection contains duration estimates; simulations never invent them.

The current decision rank is explainable and deterministic: `immediate unlocks × 1000 + known priority reach × 10 + downstream reach`. Priority labels P0/critical through P3/low contribute weights 4 through 1; missing priority stays unknown and is counted separately. Bundle search evaluates sizes two through four among at most 12 candidates and caps work at 1,000 combinations. It counts a task only when at least one selected unresolved decision releases a blocker and all other blockers are already resolved or selected. Readiness, cycle diagnoses, and health summaries are cached by immutable graph revision and source status, so a new sync invalidates analysis without recomputing it for every read. When source freshness is stale, immediate unlock and composite score are unknown. Oldest affected issue age is measured at the immutable snapshot timestamp; missing creation dates are counted as unknown. Blocked duration stays unavailable because GitHub dependency links do not provide a verified blocked-since timestamp. These weights are a starting heuristic, not a duration or completion forecast.

## Admission repairs its own missing evidence

Admission still fails closed, but "not ready" must mean a verified blocker, not "we have not looked yet". Before an issue event is judged, `admitWithRefresh` runs a single-flight incremental sync when the graph is not fresh or its last complete sync is older than five minutes. If the graph is fresh but predates the issue (a newly filed or newly labelled issue), it resyncs once more, at most every 30 seconds. A failed refresh keeps the `unknown` verdict, appends the sync failure to the deferral reason, and backs off for 60 seconds so an outage cannot become a request per check. The pre-dispatch recheck never refreshes, so the graph revision admitted is the revision dispatched.

A background sync (startup + 10 seconds, then every 10 minutes) keeps each GitHub project's projection current. It is read-only, is not gated by `localHandoff`, and is independent of the six-hour discovery scan, which still requires `localHandoff` because it dispatches runs.

## Bounded planning and mutation controls

Fresh scheduled scans persist deterministic decision candidates as `agent-proposal` records before optional model research. If the model/run service is unavailable, the proposal remains in the human review queue, the failed attempt is audited, and the dispatch returns `unavailable` without failing the scan or retrying every candidate in the same pass. The planner uses Cezar's existing run queue and worktree lifecycle, one workflow step, no recursive dispatch, and a read-only `Read` tool allowlist. Inputs label all issue content as untrusted; outputs remain run transcripts for review and never write GitHub or graph edges. Cycle attempts use stable SCC fingerprints, a three-attempt lifetime cap, and a 24-hour cooldown; decision research uses a two-attempt cap and six-hour cooldown. Failed, stale, and started outcomes are in the graph audit log.

Low-risk metadata correction is limited to the owner and evidence fields of an open `policy-approved-low-risk` decision proposal. The request must carry the current graph revision, decision revision, SHA-256 of the current decision, and an audit rationale. A rollback names a prior immutable graph revision and only restores those same metadata fields. Structural edits, authorization changes, and lifecycle changes stay on the human approval path. Scheduler issue events require a fresh graph and verified readiness both before admission and immediately before run creation; deferred receipts replay after later polls, and a local operator can override a deferred event with a reason and graph revision recorded in the automation log.

## Delivery status

Epic #145 is tracked here, not closed: four child issues have acceptance criteria that are not yet met. Delivered children close when the PR that references them merges into `dev` (the `factory-maintenance` delivery sync does this, because GitHub only closes issues on merges to the default branch).

| Issue | Delivered by | Evidence |
|---|---|---|
| #146 contracts, #147 sync/projection, #148 query API | #173, #183 | `packages/contract/src/dependency-graph.ts`, `github-source.ts`, `store.ts`; closed by the delivery sync |
| #149 readiness, SCC, loop diagnosis | #173 | `algorithms.ts` and `algorithms.test.ts` (multi-node loops, long acyclic chain, uncertain edges, no model in detection) |
| #150 impact scoring and bundles | #173 | `rankDecisions`, tests for immediate-unlock-over-reach and bounded bundle search |
| #151 graph explorer | #173 | `dependency-graph-canvas.tsx` (keyboard-operable, ARIA labels, at most 200 nodes / 800 edges per page), 5,000-node fixture test |
| #152 decision lifecycle and queue | #173 | transition graph in the contract, revision compare-and-swap, operator-only approvals, UI queue |
| #153 health overview | #173 | `dependencyGraphHealth`, stale/offline reported as unknown, never as ready |
| #154 decision discovery | #173 | `discovery.ts`, dedupe tests, no invented blocking edge |
| #155 discovery workflow | this implementation PR | deterministic proposals persist without a model; failed research returns a typed `unavailable` response and records a redacted failure event |
| #156 cycle repair planner | #173 | `repair-planner.ts`, contract-first decomposition, verified edges never dropped |
| #157 bounded replanning dispatch | #173 | `cycle-agent.ts`, attempt budgets and cooldown persisted in SQLite, non-recursive dispatch |
| #160 simulator | #173 | `algorithms.ts`, `dependency-intelligence.tsx`; immutable revision pinning, before/after readiness and cycle deltas, sanitized export, explicit unavailable critical path without duration estimates |
| #159 scheduler admission | #173, #185 | fail-closed admission, deferral replay, on-demand graph refresh. One clause, "end-to-end events visible in #135", depends on #135, which is not built; deferrals are visible in the automation log meanwhile |
| #161 history and pilot | this implementation PR | typed weekly history includes the top five bottlenecks per point; seeded cross-repository and failure-injection pilot matrix, explicit limits and rollback steps in `dependency-intelligence-pilot.md` |

Still open, with the reason:

- **#161** history and pilot: this PR adds a bounded weekly bottleneck summary and a local seeded SQLite/GitHub-adapter pilot. The pilot performs no GitHub writes and is not production rollout evidence; see `dependency-intelligence-pilot.md` for its matrix and rollback steps.

## Delivery sequence

The implementation follows epic #145: contracts, local projection and reconciliation, bounded query API, deterministic readiness/SCC and impact ranking, graph and decision views, bounded discovery and replanning, guarded scheduler admission, then simulation and audit history. No GitHub Actions compute, generic agent framework, or required Hindsight/Langfuse service is introduced.

## Approved cycle repairs

Cycle repair candidates are read-only until a local operator selects verified blocker edges,
previews the removals against the current graph revision, then approves or rejects with a rationale.
Application accepts only same-repository GitHub issue dependencies, rechecks the exact candidate
and edge set, and refuses stale source data, a surviving target cycle, new cycles, or readiness
changes outside the candidate's affected issues. The server records approval before calling GitHub,
verifies each mutation, synchronizes the resulting graph, and attempts reverse-order compensation if
any step fails. A failed compensation is retained as an explicit recovery event.

Applied repairs can be rolled back from graph history. Rollback is local-operator-only, revision
checked, and audited before and after the GitHub writes. It restores only relations that are still
absent; if a relation changed since application, rollback fails closed. Structural issue dependencies
are never changed by discovery agents or automatic policy. The existing `policy-approved-low-risk`
path remains limited to decision metadata fields.
