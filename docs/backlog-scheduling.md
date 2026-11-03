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

## UI read model (#201)
`server/backlog/view.ts` `buildBacklogView()` reshapes ranking, scheduler decisions, integration obligations and
audit into lanes, cards (priority, rank, score, top factors, scheduler reason code/detail, badges), conflict edges,
merge debt and the human-override audit, plus blocked/deferred views. The web components, the HTTP route (with its
contract-parity and route-inventory tests) and the extension of #88/#135/#151 are not built yet.

## Scheduler wiring (#198)
`ProjectAutomationHandle.backlogAdmit` is an optional gate evaluated in `ProjectAutomationScheduler.launch`
**after** the existing #159 dependency admission, revalidation and per-cycle cap, so those owners and their
regression suites are unchanged. A refusal is a durable `AutomationAdmissionDeferredError` (`backlog-scheduling: <reason>`),
retried on later turns like any other deferral. `server.ts` installs it for both the manual check and the scheduled
handle through `backlogAdmitFragment`, controlled by env `CEZAR_BACKLOG_SCHEDULING`:

| value | behaviour |
| --- | --- |
| unset / `off` | hook not installed (default; identical to before) |
| `shadow` | decision computed and logged (`[backlog-scheduling:shadow] ...`), never blocks |
| `enforce` | non-run decisions (not Ready, hold, conflict, WIP) defer the launch |

Unset the variable to kill the feature. Records are seeded from labels once (`ensureFromLabels`), so enforce
mode treats an issue as dispatchable only if its migrated lane is Ready — roll out in `shadow` first and review
the log before enabling `enforce`. Quota (#93) remains an upstream gate; the hook assumes capacity is available.
Running-work and manifest suppliers are optional inputs (`createBacklogAdmission({ running, manifest })`) and are
not yet connected to the workspace registry.

## HTTP API and UI (#194, #201)
`GET /api/v1/backlog` (lanes, scheduler reasons, conflict edges, merge debt, override audit, per-issue revisions),
`GET /api/v1/backlog/recommendation?limit=` (next Ready candidate with factor breakdown + items needing a human),
`POST /api/v1/backlog/:number` (`{expectedRevision, fields | action:"undo", reason}`; 409 stale revision, 422 rule
violation, 404 unknown). Handlers live in `server/backlog/api.ts`. The web page is `/backlog`
(`packages/web/src/routes/backlog.tsx`): lanes with the scheduler's own reason codes, per-card priority editing with
revision checks and undo, merge debt, conflict list and the human-override audit. It is reachable by URL; a sidebar
entry was not added because the nav and command-palette tests pin exact item lists.
Edits are written to the local projection only; pushing them to the GitHub issue-body block is the `pendingPush`/`markPushed`
protocol (no poller drives it yet).
