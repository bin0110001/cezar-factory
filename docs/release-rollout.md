# Release engine rollout: shadow mode, flags, rollback and metrics (#641, #643)

Libraries only: `scripts/release/release_shadow.py` and `release_rollout.py`. Nothing here changes the live promoter.

## Shadow run (`shadow_run`)

Computes what the new engine would do for a project from its release-pipeline configuration and a read-only view of its state:
trigger decisions in priority order, no-change suppression (a dev SHA equal to the last accepted candidate requests nothing, for
the schedule as well as change rules; a manual request is always honoured), capacity-aware admission, the next three schedule
ticks (DST-correct, in the project's timezone), and one of `no-request`, `would-create-candidate`, `pending-request` or
`admission-deferred`. With an active candidate every request becomes part of one pending request, so the one-active-candidate rule
holds. The receipt carries the effective configuration hash, `mutations: []` and a digest that is identical for identical inputs.
It reads the candidate store through its public read methods and never writes refs, candidates or pending rows.

## Flags (`release_rollout.py`)

`engine_for(project, flags)` is `legacy` unless the flag names `shadow` or `new`; an unknown value is `legacy`. `shadow` runs the
legacy promoter and lets the new engine observe; `new` lets it act. `set_engine` writes an audit entry and requires a reason to
leave `legacy`; going back to `legacy` is always allowed.

## Rollback runbook

1. Set the project's flag to `legacy` (`set_engine(..., "legacy", reason="rollback")`). The legacy promoter is unchanged and resumes
   as the only writer of `stable`.
2. Run `rollback_drill` (or `stable_history_intact`) to confirm `stable` is the previous value or a descendant of it. Rollback
   writes only the flag; it never rewrites a successful stable release.
3. Candidates the new engine left in flight stay in the store as history. Cancel or abandon them with `CandidateStore.end` (audited);
   do not delete rows.
4. Record the reason in the audit log and in an issue.

## Backfill and metrics

`backfill_history` converts legacy promotion records into candidate history where it can (SHA and a recognised outcome) and reports
the rest as `skipped` with a reason; it never guesses. `release_metrics` and `compare_periods` report release frequency, compute
hours, merge conflicts and mean repair time for a window and before/after a cutover, counting only fields present in the records.

Local sandbox scenarios covering these paths are in `tests/test_release_engine_scenarios.py`; the inventory and the incident map are
in `docs/release-migration-inventory.md`.
