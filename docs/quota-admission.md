# Quota-aware admission

`scripts/capacity/quota_admission.py` (`AdmissionController`) decides whether a job may be sent to a
subscription before dispatch. It consumes `capacity_telemetry.py` snapshots (#90) through a narrow
provider-to-adapters map and an ordered candidate list supplied by the caller (candidate/tier routing is #92;
the window schema is #89). The Cezar scheduler calls it; this repository ships the policy and its tests.

- `admit(job_id, candidates, priority)` checks every window (`5h`, `weekly`), active cooldowns and the
  per-provider concurrency cap, and reserves the estimated cost under one lock, so concurrent workers never
  over-commit a window or dispatch a job twice (a repeated `admit` returns the same lease, `duplicate=True`).
- Candidates are tried in order: an exhausted primary falls back to the next eligible one. If none fit, the job is
  **deferred** (never failed) with a reason and the earliest known retry time.
- Reservations are leases (`lease_seconds`): `heartbeat` extends, `complete`/`release` free them, `expire`
  reclaims those of crashed or timed-out workers.
- `report_rate_limit(job, provider, window, retry_after)` sets a cooldown: exponential backoff per consecutive
  failure, at least `retry_after`, plus jitter, capped at `max_backoff`. Deferred jobs back off exponentially
  too, and `reevaluate()` skips jobs still inside their backoff window (retry-storm guard).
- `reevaluate(force=True)` on a reset or telemetry refresh readmits deferred jobs by priority plus aging
  (`aging_per_hour`), so low-priority work cannot starve.
- After `max_attempts` unsuccessful admissions, automatic retries stop and the job remains deferred (it is not
  marked failed).
- Unknown capacity: `unknown_mode="conservative"` (default) defers; `"optimistic"` admits up to
  `optimistic_unknown_limit` concurrent probes per provider.

State is in-process; the scheduler owns persistence across restarts (leases that outlive a crash expire).
