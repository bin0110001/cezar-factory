# Workflow liveness, cycle and progress intelligence (#766)

`scripts/release/workflow_liveness.py` is a pure, deterministic library (no clock, IO, randomness or model call). The caller
supplies `now` and a versioned history document (`schemas/workflow-liveness.schema.json`, `schemaVersion: 1`; any other version
raises). Finding progress is delegated to `progress_evaluator.evaluate` (#739/#736) over the transitions' `observation`s, so
there is no second fingerprint store; `quality_findings.py` (#52) fingerprints are the findings it consumes.

## Classification

`status` is `stalled` (any class below), `unknown`, `waiting`, `progress` or `ok`. Each stall class has a stable reason code and
deterministic `nextAction`; `witness` carries the graph path and the class-specific blocker.

| class | reason code | action |
|---|---|---|
| unchanged_findings (cap `maxUnchangedRounds`) | LIVENESS_UNCHANGED_FINDINGS | escalate |
| oscillation (A->B->A) | LIVENESS_OSCILLATION | escalate |
| repeated_edge (identical state repeated `maxRepeatedEdge`) | LIVENESS_REPEATED_EDGE | investigate |
| dead_end, wait_for_cycle, unsatisfiable_join | LIVENESS_DEAD_END / _WAIT_FOR_CYCLE / _UNSATISFIABLE_JOIN | investigate |
| missing_external_event, lost_lease, missing_admission | LIVENESS_MISSING_EXTERNAL_EVENT / _LOST_LEASE / _MISSING_ADMISSION | resume_reconcile |
| overdue_human_wait | LIVENESS_HUMAN_WAIT_OVERDUE | human_action |
| capacity_starvation | LIVENESS_CAPACITY_STARVATION | infra_backoff |
| regression | LIVENESS_REGRESSION | same_session_repair |
| budget_exhausted (rounds/time/resource) | LIVENESS_BUDGET_EXHAUSTED | escalate |

A new finding exposed after fixing old ones is progress, not a stall. A human/time/external wait inside its `deadline` is
`waiting` (`LIVENESS_HEALTHY_WAIT`), never a cycle. Stale SHA, missing verification, partial review coverage or inconclusive
progress yield `unknown` (never success). Child `rounds` + `resets` count against the parent's `maxRounds`, so a child reset
cannot bypass the parent budget. `authorize_action` accepts a model-proposed action only if the policy already allows it.
Evidence is redacted of token/secret patterns.

## Compatibility and gaps

Input is a documented adapter shape; the static validator, hierarchical runtime (#761) and #149/#433 are not yet wired to emit it,
and `factory_local_scheduler.py` is not yet calling the library. Until then it is consumed by tests and adapters only; no
lifecycle, routing or promotion behavior changes, so `docs/workflow-map.md` is unchanged.
