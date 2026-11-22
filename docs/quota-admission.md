# Quota-aware admission

`scripts/capacity/quota_admission.py` (`AdmissionController`) is the original tested policy reference for deciding
whether a job may be sent to a subscription before dispatch. It consumes `capacity_telemetry.py` snapshots (#90)
and an ordered candidate list from the caller (#92). The Cezar runtime does not invoke this Python controller.
Its TypeScript implementation under `cezar/packages/cezar/src/server/capacity/` is called at the GitHub
automation scheduler launch boundary. Capacity waits use the scheduler's durable receipt queue, with a retry
deadline and reason, while the workspace ledger serializes reservations across project schedulers and processes.

- `admit(job_id, candidates, priority)` checks every window (`5h`, `weekly`), active cooldowns and the
  per-provider concurrency cap, and reserves the estimated cost under one lock, so concurrent workers never
  over-commit a window or dispatch a job twice (a repeated `admit` returns the same lease, `duplicate=True`).
- Candidates are tried in order: an exhausted primary falls back to the next eligible one. If none fit, the job is
  **deferred** (never failed) with a reason and the earliest known retry time.
- Reservations are leases (`lease_seconds`): `heartbeat` extends, `complete`/`release` free them, `expire`
  reclaims those of crashed or timed-out workers.
- Provider rate-limit errors with `retry-after` set a shared cooldown: exponential backoff per consecutive
  failure, at least `retry_after`, plus jitter, capped at `max_backoff`. Deferred jobs back off exponentially
  too, and `reevaluate()` skips jobs still inside their backoff window (retry-storm guard).
- `reevaluate(force=True)` on a reset or telemetry refresh readmits deferred jobs by priority plus aging
  (`aging_per_hour`), so low-priority work cannot starve.
- `max_attempts` caps exponential growth; deferred work continues at the bounded retry interval so capacity
  recovery remains automatic without a per-poll retry storm.
- Unknown capacity: `unknown_mode="conservative"` (default) defers; `"optimistic"` admits up to
  `optimistic_unknown_limit` concurrent probes per provider.

Capacity profiles are host-local (`~/.cezar/subscription-profiles.json`); a missing file keeps legacy behavior.
Unknown-capacity behavior defaults to conservative and can be changed in
`~/.cezar/quota-admission-policy.json`. Provider account references are resolved against Cezar's existing account
store and are never copied into receipts or run events. The automation receipt is the durable deferral record;
leases heartbeat while the created run is active and expire after a crash.
