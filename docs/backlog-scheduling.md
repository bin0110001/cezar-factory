# Explainable ranking and unified admission (#194, #198; epic #192)

Code: `cezar/packages/cezar/src/server/backlog/{ranking,scheduling,admission-ledger}.ts`.
Tests: `cd cezar/packages/cezar && CEZ_HOME=<tmp> npx vitest run src/server/backlog`.

## Ranking (`ranking.ts`)
Deterministic score = base-priority tier + rank-in-tier bonus + live expedite + capped aging +
capped unlock/critical-path (#150 inputs) + small effort and due-date terms. Every term is
returned in `factors[]`; inputs that were unavailable are listed in `missingInputs` (unknown is
not zero). Aging is capped below the tier gap, so it prevents starvation without leapfrogging
priority. Config is versioned (`RANKING_CONFIG_VERSION`). No LLM or hidden input.

Hard gates (lane not Ready, hold, closed, policy constraints, snooze, caller-supplied external
gates) are **not** scored: they come back as `gates[]`, so a blocked P0 keeps its importance but
is not dispatchable. `recommend()` returns the next eligible candidate, the top N with full
breakdown, and items that need a human (unset priority in Inbox/Refinement/Backlog).

## Admission (`scheduling.ts`)
`decideOne` runs ordered stages and returns `RUN | DEFER | BATCH | COORDINATE | INTEGRATE` with a
reason code and the source revisions (`decisionKey` makes replays comparable):
lane/hold -> dependency (#159 verdict; unknown fails closed) -> approval -> ownership ->
capacity (#93 verdict; quota-exhausted, capacity-unknown, wip-limit, wip-reserved are distinct) ->
conflict vs running work (file/contract serialize; unknown/stale manifest serializes; module-only
is COORDINATE; audited `forceOverlap` is INTEGRATE with an idempotent `obligationKey`).
`scheduleRound` walks candidates in dispatch order so a blocked P0 never consumes capacity a
Ready P2 can use, and candidates admitted together are marked BATCH. Deferral never lowers base priority.
`enforce` defaults to **false**: decisions are `shadow` until a project opts in (kill switch).

## Atomic admission (`admission-ledger.ts`)
Per-issue claim + capacity reservation in one immediate SQLite transaction with leases (TTL),
idempotent replay for the same holder, token-checked release. Local-file only: it excludes
duplicate scheduler processes on one host; multi-host exclusion needs the #197 coordinator.

## Not in this change
Wiring `decideOne`/the ledger into `automations/scheduler.ts` and the existing #93/#159 gates,
intake dedupe and the Refinement/Ready checklists, reprioritisation actions (undo, bulk, snooze UI),
the recommendation HTTP API, and #127/#128 events. These remain open on #194 and #198.
