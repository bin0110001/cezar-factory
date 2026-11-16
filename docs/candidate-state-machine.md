# Candidate state machine and ownership lease

`scripts/release/factory_candidate_state.py` is a durable (SQLite, WAL) store that
guarantees **one nonterminal release candidate per project**, across every
trigger, process and test node. It is additive: it is not yet wired into the
release controller or `factory_local_scheduler` (follow-up). Config hash and
project id are opaque inputs.

## States and legal transitions

`requested → admitted → snapshotting → validating → (repair-required ⇄ revalidating) → ready → awaiting-approval → promoting → activating → promoted`

- `ready → promoting` is also legal (autonomous posture); `failed` is reachable from any nonterminal state with a valid fence.
- `canceled` / `abandoned` are reachable only through `cancel()` (audited: actor, reason, time).
- `ready` needs a passed test run for the current revision; `repair-required` a failed one; `activating` needs a promotion receipt and `promoted` an activation receipt.

## Rules

- A partial UNIQUE index on `candidates(project)` for nonterminal states enforces the single active candidate in the database; a worker lock alone is not relied on.
- Requests arriving while a candidate is active are folded into **one pending request** (triggers appended, original SHAs kept). `admit_pending()` runs only when no candidate is active.
- Every mutation runs in `BEGIN IMMEDIATE` and checks the **fencing token** (and an unexpired lease) plus the expected **revision**. Tokens are per-project and strictly increase on each lease takeover and on cancel, so a stale worker or a delayed result from an obsolete revision is rejected and changes nothing.
- Revisions of one candidate are sequential: `snapshot()` records revision 1, `new_revision()` (from `repair-required`) the next, each with a unique immutable SHA. One test run per revision, and at most one run `running` per candidate; finished evidence is immutable.
- Commands take an optional idempotency key; a repeat returns the original result. Receipts are unique per candidate and kind.
- `reconcile(project, owner, ttl, probes)` takes over an expired lease (higher token), marks runs that no probe reports live as lost, fails the candidate on ref mismatch or missing artifact, and never admits a second candidate.

Tests: `tests/test_factory_candidate_state.py` (100-way thread and process races, illegal transitions, stale fence/revision, crash/restart, partition, replay, cancel).
