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

Project routes under `/api/v1/p/:projectId/` provide bounded snapshot pages and diffs, node detail and impact, bounded neighborhood expansion, readiness and cycle diagnoses, review-only cycle repair candidates, health counts, decision ranking and candidate discovery, recent event history, weekly historical trends, sanitized diagnostics export, proposal creation and review transitions, counterfactual simulation, and explicit GitHub synchronization. Snapshot pages support server-side title/ID, repository, kind, state, and readiness filters and can pin a requested immutable revision. Synchronization starts only on `POST .../dependency-graph/sync`; read routes use the cached graph and mark data stale after 24 hours. Decision proposal writes use graph revision compare-and-swap and cannot approve themselves. Proposed agent records can be edited; the local operator can create proposals that require human approval. State transitions also require the current graph revision; operator approval transitions are served only on the local operator surface and are recorded in the audit log. Simulation accepts at most 100 edge additions/removals and 100 issue/decision outcomes, cannot assert a new verified blocker, and reports `persisted: false`. Critical path is explicitly unavailable until the source projection contains duration estimates.

The current decision rank is explainable and deterministic: `immediate unlocks × 1000 + known priority reach × 10 + downstream reach`. Priority labels P0/critical through P3/low contribute weights 4 through 1; missing priority stays unknown and is counted separately. Bundle search evaluates sizes two through four among at most 12 candidates and caps work at 1,000 combinations. It counts a task only when at least one selected unresolved decision releases a blocker and all other blockers are already resolved or selected. Readiness, cycle diagnoses, and health summaries are cached by immutable graph revision and source status, so a new sync invalidates analysis without recomputing it for every read. When source freshness is stale, immediate unlock and composite score are unknown. Oldest affected issue age is measured at the immutable snapshot timestamp; missing creation dates are counted as unknown. Blocked duration stays unavailable because GitHub dependency links do not provide a verified blocked-since timestamp. These weights are a starting heuristic, not a duration or completion forecast.

## Bounded planning and mutation controls

Fresh scheduled scans can persist deterministic decision candidates as `agent-proposal` records and dispatch at most one high-impact research run per project scan. The planner uses Cezar's existing run queue and worktree lifecycle, one workflow step, no recursive dispatch, and a read-only `Read` tool allowlist. Inputs label all issue content as untrusted; outputs remain run transcripts for review and never write GitHub or graph edges. Cycle attempts use stable SCC fingerprints, a three-attempt lifetime cap, and a 24-hour cooldown; decision research uses a two-attempt cap and six-hour cooldown. Failed, stale, and started outcomes are in the graph audit log.

Low-risk metadata correction is limited to the owner and evidence fields of an open `policy-approved-low-risk` decision proposal. The request must carry the current graph revision, decision revision, SHA-256 of the current decision, and an audit rationale. A rollback names a prior immutable graph revision and only restores those same metadata fields. Structural edits, authorization changes, and lifecycle changes stay on the human approval path. Scheduler issue events require a fresh graph and verified readiness both before admission and immediately before run creation; deferred receipts replay after later polls, and a local operator can override a deferred event with a reason and graph revision recorded in the automation log.

## Delivery sequence

The implementation follows epic #145: contracts, local projection and reconciliation, bounded query API, deterministic readiness/SCC and impact ranking, graph and decision views, bounded discovery and replanning, guarded scheduler admission, then simulation and audit history. No GitHub Actions compute, generic agent framework, or required Hindsight/Langfuse service is introduced.
