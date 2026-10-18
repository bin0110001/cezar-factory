# Factory environment analysis

Collection: 2026-10-16T18:46:38Z  
Source export: `environment-state-latest.json`  
Factory version: `0.3.44`  
Repository branch at collection: `codex/implementation-tool-loop-guard`

## Executive summary

The evidence points to three separate problems rather than one generic pipeline issue:

1. Build/implementation reliability is weak at the validation boundary. The bounded Cezar history contains 3 failed runs out of 100 (3%), and all three fail in `validate` with `route` still pending. Two are implementation runs and one is the fix-review run that was meant to recover an earlier issue.
2. Auto-fix is executing, but recovery is not dependable. The sampled fix-review history has two completed runs for `blackjackandhookersgadot` and one failed run for `tableflux-animation-pipeline`; completion is not yet tied to a verified issue recovery or merged PR, so the current system cannot demonstrate that auto-fix improves outcomes.
3. Monitoring and scheduled safety nets are disabled on the targets that need them most. `failure-audit` is disabled on all three configured targets; `godot-upgrade` is disabled on the Godot target; every Factory automation on `cezar-factory` is disabled. That makes pickup and failure symptoms harder to detect and explains why fixes can appear to disappear.

GitHub CI is also a material signal: 7 of the 35 bounded runs are failures (20.0%), all from `factory-ci` in the sampled history. This is separate from Cezar run health but confirms that the Factory checkout itself has had recurring validation instability.

## Evidence

| Area | Observation | Confidence | What it means |
|---|---|---:|---|
| Cezar execution | 100 runs collected across two active targets; 3 failed | High | Failures are concentrated in the terminal validation handoff, not startup or implementation steps |
| Failure shape | `factory-implement` failed twice and `factory-fix-review` failed once; each had `validate:failed` and `route:pending` | High | The next debugging target is validation-result production/consumption and route-state handling |
| Auto-fix | `tableflux-animation-pipeline` fix-review run failed after ~42 minutes; two analogous fix-review runs completed on the Godot target | High | Auto-fix is not a reliable closed loop yet; “done” needs post-fix proof |
| Schedules | `maintenance` is enabled hourly on the two active targets; `failure-audit` is disabled on all three | High | Routine housekeeping runs, but failure detection is not continuously protecting the system |
| Automation drift | Enabled automations: 11 on Godot, 12 on TableFlux, 0 on `cezar-factory` | High | The Factory project itself is not an active test/operations target in Cezar |
| GitHub CI | 33 runs collected, 7 failures (21.2%), one workflow (`factory-ci`); repository workflow file has push/PR triggers and no schedule | High | CI failures need a failure-class breakdown before more automation is layered on |
| Pickup latency | Run records expose `createdAt` and `startedAt`, but not a durable queue/enqueue timestamp or a cross-run pickup percentile | Medium | The current platform cannot prove “picked up too slowly”; add queue-age telemetry before deciding to fork |

## Prioritized improvement paths

### P0 — Make validation failures diagnosable and routable

Inspect the three failing run artifacts and make the validation step emit a structured result that always includes `status`, `reason`, `command`, `exitCode`, and an artifact reference. Make `route-state` consume that result and close the loop when validation fails instead of leaving `route` pending. Add a regression fixture for “validation failed after implementation” and “fix-review validation failed”.

Success signal: 20 consecutive induced validation failures produce a terminal route and a bounded evidence artifact; zero runs remain pending solely because validation failed.

### P1 — Turn auto-fix into a measured recovery loop

For every fix-review launch, record the source failure run, issue/PR, changed files, validation result, and a follow-up verification result. Treat a fix-review run as successful only when the original failure condition is gone or the PR has a verified human review handoff. Add a deduplication/cooldown guard so repeated failures do not create expensive overlapping repair attempts.

Success signal: report fix-review recovery rate, median time to recovery, repeat-failure rate, and cost per recovered issue over 30 days.

### P1 — Re-enable bounded failure visibility

Enable `[factory] failure-audit` on the two active targets first, with its existing bounded 20-run limit and issue deduplication. Keep it disabled on `cezar-factory` until the project has a deliberate workload, but make that decision explicit. Add an automation-health report that flags disabled managed automations, consecutive failures, stale `nextRunAt`, and zero launches over the lookback window.

Success signal: every active target has a daily audit receipt, and disabled/stale managed automations are visible in one report.

### P2 — Improve pickup and fairness telemetry before changing the scheduler

Add `queuedAt`, `startedAt`, `finishedAt`, `automationTrigger.nextRunAt`, and `automationTrigger.occurrenceAt` to a normalized execution record. Compute p50/p95 pickup latency by workflow and target, plus duplicate, retry, and starvation counts. Use those measurements to tune polling intervals, concurrency, and fairness.

Success signal: seven days of complete queue-age data with p95 pickup latency and no unclassified queued runs.

### P2 — Stabilize Factory CI separately from Cezar runtime

Classify the 7 GitHub failures by failing job and assertion, then fix the highest-frequency class. Keep GitHub CI results linked to the Factory commit and release report so a green source CI run cannot be mistaken for a healthy remote Cezar runtime.

Success signal: failure-class dashboard plus a 90%+ successful CI rate across 30 comparable runs.

## Fork decision record

Do not fork Cezar yet. The current evidence supports Factory-side fixes and better observability first. A fork becomes justified only if a short, instrumented trial shows that the upstream/runtime contract cannot provide all of the following: durable queue age, per-automation health and consecutive-failure state, idempotent trigger keys, structured failure artifacts, and a terminal state for every failed validation.

If that trial fails, fork narrowly around the scheduler/observability boundary, preserve the existing Factory workflow and automation contracts, and maintain a compatibility test suite against the upstream API. Do not fork application behavior or provider integrations merely to compensate for missing measurements.

## Immediate next actions

1. Reproduce one `validate:failed` run in an isolated fixture and capture its structured validation artifact.
2. Repair the validation-to-route terminal transition and add the regression tests.
3. Add auto-fix recovery linkage and metrics before increasing retry counts or model spend.
4. Enable the bounded failure audit on the two active targets after the release gate passes.
5. Run this skill again after seven days to compare pickup, failure, and recovery metrics.
