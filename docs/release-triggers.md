# Release triggers and admission (#591)

`scripts/release/release_triggers.py` decides when a release candidate should be requested. It is pure: the clock
is a parameter, nothing is started, and every decision carries its reasons. A `request` decision is submitted to the
candidate store (`docs/release-candidate-store.md`), which admits one candidate and folds everything else into a
single pending request, so concurrent sources never produce a second candidate or simultaneous execution. There is
no scheduler service: the existing Cezar scheduler and quotas (#93) and GitHub reconciliation (#222) are expected to
call `evaluate`.

## Schedules

Calendar `daily` or `weekly` schedules with an IANA timezone, evaluated in that zone. A wall-clock time that a DST
jump skips fires at the first valid moment after the gap; an ambiguous time (clocks falling back) fires on its first
pass only, once. Several missed ticks coalesce into one request (`missedRun: coalesce`) or, with `skip`, only a tick
still inside `missedGraceMinutes` runs and older ticks are consumed without running. The returned `occurrence` is the
tick to record as consumed.

## Change rules

No-op when the dev SHA equals the last accepted candidate or nothing relevant changed (`paths`). Otherwise thresholds
(`minCommits`, `minFiles`, `minElapsedHours`, a risk flag) are combined with `any` or `all`. A met rule can still
`defer` for quiet hours or a cooldown, with a `retry_at`; `maxDelayHours` forces a request past both and past
unmet thresholds.

## Combining sources and replay

`evaluate` returns the manual, schedule and change decisions in the configured `priority` order. Each `request`
carries an idempotency key built from project, trigger, tick and dev SHA, so a duplicate event replays to the original
outcome in the store.

## Admission

`admission` explains every refusal (fast checks, ref reachability, capacity, optional empty queue). `backoff_seconds`
doubles from 60 s up to 3600 s for infrastructure failures.

Example presets for a weekly project and a daily project that also enables a commit threshold are in
`config/release-pipeline.example.json`.
