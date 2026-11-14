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
