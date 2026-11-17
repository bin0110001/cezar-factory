# Release candidate store (#590)

`scripts/release/release_candidate_store.py` is a library (Factory scripts run from workflow steps) holding durable
candidate state in one SQLite file. It guarantees at most one nonterminal candidate per project across every trigger,
process and test node. Nothing in the live promoter calls it yet; the trigger work (#591) and the later release
stages adopt it.

## Invariants

- **One active candidate per project, enforced by the database.** A partial unique index on `project_id` for
  nonterminal states means a second active row is impossible even if application code is wrong. Writers use
  `BEGIN IMMEDIATE`, so a race of any size admits one candidate; the rest fold into a single `pending` request that
  accumulates every trigger and reason. A pending request is handed back by `take_pending` only after the active
  candidate is terminal, and it never starts a candidate by itself.
- **Fencing.** `acquire` grants a lease; the fencing token increases whenever ownership changes and never otherwise.
  Every mutation checks the token, an unexpired lease, and (for transitions) the row `version`, so an owner that
  crashed, partitioned or was replaced cannot write. An operator `end` also bumps the token and is audited.
- **Revisions are sequential within one candidate.** `new_revision` is allowed only from `snapshotting` or
  `repair-required`, SHAs are unique per candidate, and there is no second concurrently running revision.
- **Evidence is immutable and revision-bound.** `record_result` refuses a result for any revision but the current one
  and refuses a repeated run id. `ready` requires at least one result for the current revision and none failing, so a
  delayed result from an obsolete revision can never turn a candidate green.
- **Idempotency.** `request` replays an `idempotency_key` to its original outcome; `record_promotion` replays a
  `receipt_id` instead of promoting twice.

## States

`requested, admitted, snapshotting, validating, repair-required, revalidating, ready, awaiting-approval, promoting,
activating`, then terminal `promoted | abandoned | failed | canceled`. Legal transitions are the `TRANSITIONS` table;
any nonterminal state may end as abandoned, failed or canceled.

## Recovery

`stale_candidates(now)` lists nonterminal candidates whose lease lapsed (the startup worklist). The caller reconciles
repository refs, runs and artifacts against it (those checks need Git and the run store, so they belong to the workflow
that adopts this store) and then either re-acquires the lease or ends the candidate with `end`. A candidate #2 is never
admitted until #1 is terminal.

## Stored per candidate

Candidate id, project, state, row version, revision, dev SHA, base stable SHA, candidate SHA, config hash (from
`docs/release-pipeline-config.md`), owner, lease expiry, fencing token, timestamps; plus revisions, results, pending
request history, promotion receipts and an append-only audit log.

## Operator action inbox (#634)

`scripts/release/release_action_inbox.py` is the engine side of the Control Center candidate actions. The Control Center appends audited requests to `~/.cezar/release/actions.jsonl`; `process()` applies each one not yet decided against this store, which stays the authority, and returns one decision per request for `action-decisions.jsonl`, so a rerun applies nothing twice.

- `create` and a retry of a failed candidate go through `CandidateStore.request` (trigger `manual` or `retry`, idempotent on the request id), so a project with an active candidate gets the single pending request and never a second candidate. The engine supplies the dev and stable SHAs and the bound configuration hash; with none, the request is rejected.
- `cancel` and `abandon` need `confirmed` and end only the named active candidate through `CandidateStore.end`, which fences out the lease holder.
- `pause`, `resume` and retry of a candidate in `repair-required` are recorded, not applied: the store has no state for them and only the lease owner moves a candidate. `paused_projects()` and `retry_requests()` are what the owning worker reads.

A request naming a candidate that is not the active one, a finished candidate, or an action that does not fit the state is rejected with the reason. Gap: the scheduled engine step that reads and appends the files, and the worker that honors holds and retry markers, are not wired yet.

## Running the inbox step

`scripts/release/release_inbox_step.py` is one run of both inboxes (`release_waiver_inbox`, `release_action_inbox`), started every minute by `integrations/bazzite/factory-release-inbox.timer` on the Bazzite host, beside the promoter and separate from it. It reads `waivers.jsonl` and `actions.jsonl`, appends `waiver-decisions.jsonl` and `action-decisions.jsonl`, and writes `holds.json` (the projects an operator paused, for the owning worker). Each waiver is decided against the effective quality policy for its project. Actions run against the candidate store; `create` and a retry bind the candidate to the fetched `origin/dev` and `origin/stable` and to the hash of the project's effective pipeline configuration (the built-in defaults when nothing is saved; a saved but invalid document rejects). A missing ref or an unreadable quality policy rejects or defers only the requests that need it and never guesses. The step never fetches, pushes, promotes or deploys.

Deployment prerequisite: the Control Center writes under the Cezar container's `CEZ_HOME/release`, so that directory must be the host `~/.cezar/release` (a bind mount) before the timer does anything. Until then the files the step reads do not exist and each run is a no-op. Enable with `systemctl --user enable --now factory-release-inbox.timer` through the supported deployment flow, not by hand on the host checkout.
