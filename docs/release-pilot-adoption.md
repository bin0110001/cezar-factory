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
3. For each project, bind the same workflow definition and parity policy in that project's `.ai/cezar/workflow-rollout.json`; keep `mode: shadow` until distinct exact-policy matches meet `minParitySamples`. The project-local verification provider supplies its configured suites/adapters. Shared runtime behavior does not branch on project name.
4. `set_engine(..., "new", reason=...)` for one project at a time. Each change is audited; `engine_for` and `route` reflect it.
5. `compare_periods` around the cutover records the before/after release figures below. `workflow_pilot_metrics` summarizes optional review, normalized finding, liveness, usage, and evidence timestamps from existing telemetry/run events. It reads at most 10,000 recent events in a bounded window, emits aggregate counts only, and leaves rates and totals unavailable when the corresponding evidence is absent.
6. Before authority changes, run `rollback_drill`: release rollback returns to `legacy` and preserves stable history; workflow rollback sets `mode: legacy` while retaining the version and policy pins. Both are covered by fixture tests.

## Status

Default stays `legacy`. Live shadow and flag-on for each project are pending operator action on the host that holds the project's
registry entry and promotion records; this change ships the configs, tests and procedure. No production run was performed.

## Before/after evidence

Live records are not available in this worktree, so the table is `compare_periods` over a synthetic fixture (14 days before, 7 days
after a cutover) to show the format. The workflow metrics tests also use synthetic events. Neither fixture establishes pilot performance.
Replace the release figures and attach the aggregate workflow metrics from existing telemetry after shadow collection; retain source
events under their existing store's retention policy, not in a new metrics ledger.

For `workflow_pilot_metrics`, the read-only adapter projects existing records into event facts: `reviewOutcome` is one of
`confirmed`, `unconfirmed`, or `false-positive`; `findingState` is one of `confirmed`, `needs-verification`, or `false-positive`;
`liveness` is the existing classifier status; `repeatedLoop` is its boolean loop signal; `costUsd`/`tokens` are usage facts included
once per run; `evidenceAt` is the timestamp of the evidence being evaluated; and `at`/`ts` is the observation timestamp. The report
returns no identifiers, prompts, findings, or free text. The bounds are 10,000 events and 365 days. Malformed/future timestamps
and unknown enum values are not counted.

| Metric | Before | After | Delta |
| --- | --- | --- | --- |
| Releases per week | 1.0 | 2.0 | +1.0 |
| Compute hours | 3.0 | 1.0 | -2.0 |
| Merge conflicts | 3 | 0 | -3 |
| Mean repair hours | 24.0 | unavailable (no repairs recorded) | unavailable |

## Authority evidence checklist

Before changing workflow authority, record current distinct parity samples for the exact workflow digest and policy version, the
latest successful review and verification evidence timestamps, and the aggregate review/finding/liveness/spend report for the pilot
window. Stale, missing, or malformed evidence remains unknown and cannot count toward confirmation or the parity threshold. Exercise
both rollback fixtures and verify the stable history and pinned workflow version remain intact. Live flag changes and host-local
registry edits require a separately authorized Production Run.
