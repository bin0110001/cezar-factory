# Release engine pilot adoption (#644)

cezar-factory (daily) and TableFlux (weekly) run on the same release engine. They differ only in
`config/release-pipeline.pilot.example.json`; no engine code names either project and neither needs specific hardware.

| Setting | cezar-factory | TableFlux |
| --- | --- | --- |
| Preset | `daily-calendar` | `weekly-calendar` |
| Schedule | every day 04:30 America/Detroit | Thursday 03:00 America/Detroit (`dayOfWeek`, `hour`, `minute`, `timezone` configurable) |
| Suites (generic adapter) | `full-suite` | `unit`, `e2e` |
| Resource bounds | `candidateLifetimeHours` 24, `repair.maxAttempts` 3 | `candidateLifetimeHours` 72, `repair.maxAttempts` 2, 60 min soak |
| Promotion | self-review, auto stable | approval, approval stable |

The engine has no dedicated compute-budget key (adding one is a new engine feature, out of scope). The bounds above are the
existing configurable limits. A project with Godot or distributed suites lists them in `tests.suites` the same way; the worker
profile and asset mounts come from the verification provider, not from this config.

## Procedure

1. Copy the project entries into the real release-pipeline config. Target registration stays in the host-local `config/factory-projects.json`.
2. `set_engine(flags, project, "shadow", actor=..., reason=...)`. `shadow_run` produces a receipt with `mutations: []` and a deterministic digest; compare it with what the legacy promoter does for several ticks.
3. `set_engine(..., "new", reason=...)` for one project at a time. Each change is audited; `engine_for` and `route` reflect it.
4. `compare_periods` around the cutover records the before/after figures below. Fields absent from the legacy records are reported unavailable, never guessed.
5. Before flag-on, run `rollback_drill`: the flag returns to `legacy` and `stable_history_intact` is true. It is covered by `tests/test_release_shadow_rollout.py` (`Pilots`).

## Status

Default stays `legacy`. Live shadow and flag-on for each project are pending operator action on the host that holds the project's
registry entry and promotion records; this change ships the configs, tests and procedure. No production run was performed.

## Before/after evidence

Live records are not available in this worktree, so the table is `compare_periods` over a synthetic fixture (14 days before, 7 days
after a cutover) to show the format. Replace it with real figures after cutover.

| Metric | Before | After | Delta |
| --- | --- | --- | --- |
| Releases per week | 1.0 | 2.0 | +1.0 |
| Compute hours | 3.0 | 1.0 | -2.0 |
| Merge conflicts | 3 | 0 | -3 |
| Mean repair hours | 24.0 | unavailable (no repairs recorded) | unavailable |
