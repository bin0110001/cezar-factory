# Bounded triage/repair loop (issue #105)

`workflows/verification-repair.yaml` lets an agent attempt targeted repair of verification failures within
hard bounds. Every bound is enforced by `scripts/repair-loop-step.ps1` (library: `scripts/repair-loop-lib.ps1`),
not by prompt text. The step runs only from the workflow's `command:` step; the agent never runs it.

## Inputs

- `.factory/verification-checks.json`: `{ "checks": [ {checkId, status, message, output, commitSha, history, flaky, safetyViolation, securityIssue} ] }`,
  the current result of the impacted checks (#53 selection). `status` is `passed`, `failed` or `untested`.
- `policies/retry.yaml`: `max_implementation_retries`, `environment_failure_handling`, `flaky_test_handling`,
  `stop_automatic_modifications_on`. The loop only consumes these; an unreadable or incomplete policy, or an
  unreadable ledger, fails the step closed (non-zero, nothing written).
- Optional `-HindsightPath` (#55 recall). Absent or damaged recall is ignored.

## Classification and routing

| Class | Rule | Route |
| --- | --- | --- |
| `untested` | not run / skipped / deferred | no repair; gap stays visible; handed off |
| `flaky` | passed and failed on the same commit, or flagged | retry once, then flagged for investigation and handed off |
| `infrastructure` | timeouts, connection errors, 429/502/503/504, rate limits | back off (30 s doubling, max 900 s), no repair; handed off once the bound is reached |
| `code-defect` | assertion/syntax/type evidence, or anything else | targeted repair while attempts remain |

Assertion evidence outranks infrastructure words. Rules are deterministic and reviewed source, not model output.

## Bounds

A repair round costs one attempt however many checks it covers. The loop stops (`action: stop`, no checks
impacted, no further modification) when attempts reach `max_implementation_retries`, when the same failure
fingerprint is still failing after two repair attempts (`repeated_failures`), or when a check reports
`safetyViolation` or `securityIssue`. Only impacted checks are rerun after each attempt.

## Ledger and budget

`.factory/repair-ledger.json` (schema version 1) is append-only per round: round, time, check, class, action,
fingerprint, outcome (`pending` resolved to `fixed` or `still-failing` on the next round) and `costSeconds`.
`budget` in the decision reports attempts used/remaining, flaky retries, backoffs and total cost seconds.
This is the attempt record for the verification ledger (#52); the loop does not write the #52 finding store.

## Handoff

Persistent failures stay visible in the decision and in `.factory/repair-loop-handoff.json`
(`target: failure-audit-publication`, `createsIssue: false`, `waiver: false`) for the #30/#31 audit and
publication path. The loop creates no issue and no waiver. The concise context comes from the #103 summary.

Tests: `tests/repair-loop.ps1` (fixtures only; deploys nothing).

## Repair authorization policy (#740)

`policies/repair-policy.json` (schema `schemas/repair-policy.schema.json`) is the Factory layer of a versioned
authorization policy. Project, workflow and validator override files (`-OverridePolicyPath`, same schema, `layer` set)
are merged Factory → project → workflow → validator and may only **tighten**: limits never exceed the layer below, a
ceiling can be added or lowered but not removed, governance flags (`stopOnSafetyViolation`, `stopOnSecurityIssue`,
`requireRequiredGates`) cannot be turned off, `allowIncompleteAsSuccess` stays false, and independent diagnosis cannot be
enabled below the Factory layer (and is never a retry strategy). Any invalid, unreadable or loosening layer fails the step
closed. The effective snapshot (with a SHA-256 digest and `policyVersion`) is recorded in every receipt; the stricter of
`retry.yaml` `max_implementation_retries` and `totalRepairRounds` wins.

Limits: `totalRepairRounds`, `unchangedFindingPersistence`, `consecutiveNoProgress`, `oscillationLimit`, `replanCap`,
`infraRetryBudget`; optional ceilings `maxSeconds`, `maxTokens`, `maxCostUsd`. Initial validation uses zero repair
rounds. Repair attempts (reservations) and infrastructure/flaky retries are counted separately in `budget`.

### Strategies and reason codes

Each evaluation yields one action and one receipt: `repair` (in-session focused repair, default), `replan` (in-session,
same bot, only after a repair left the same finding unchanged and while `replanCap` allows; it spends the same repair
budget), `retry`/`backoff` (infrastructure, own budget), `stop`, `handoff`, `done`. Terminal reason codes: `passed`,
`incomplete_reported`, `repeated_finding`, `oscillation`, `no_progress`, `global_budget_exhausted` (attempt cap or a
time/token/cost ceiling), `validator_error`, `governance_stop`, `session_unavailable`; non-terminal rounds use
`repair_authorized`, `replan_authorized`, `retry_authorized`, `backoff_authorized`. Precedence when several apply:
governance, validator error, session unavailable, repeated finding, budget, oscillation, no progress. Checks reporting
`incomplete: true` or untested always end as `incomplete_reported` (outcome `incomplete`), never a successful handoff.

Progress is derived from the failing-finding sets between rounds (something fixed or fewer findings = progress; a
`relevantChange: true` check resets persistence). The progress evaluator (#736) may supply `-ProgressPath`
(`{"state":"progress|none|unknown"}`); missing or unknown counts as no progress.

### Atomic reservation and receipts

The step decides under an exclusive lock on `<ledger>.lock` and writes the ledger atomically, so concurrent evaluations
cannot overspend the cap. A reservation is idempotent on `-IdempotencyKey` (default `round-N`): replaying a key returns
the original decision and receipt; a cancelled reservation (`Set-RepairReservationState`) releases the budget and its key
is not silently re-granted. Session continuation and replans never reset the budget. `receipts` in the ledger are
append-only, validated by `schemas/repair-receipt.schema.json`, and carry a digest. Ledgers stay `schemaVersion` 1;
`reservations` and `receipts` are additive and legacy repair entries migrate into reservations on first read.
