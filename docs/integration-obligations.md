# Integration obligations, drift and pilot metrics (#199, #200, #202; epic #192)

Code: `cezar/packages/cezar/src/server/backlog/{integration-obligations,drift,metrics}.ts`.
Tests: `npx vitest run src/server/backlog/obligations-drift.test.ts` (from `cezar/packages/cezar`).

## Integration obligations (#199)
- Durable SQLite record per overlapping pair, keyed idempotently by `obligationKey(a, b)` (order-independent).
  `ensure` never duplicates; repeated evidence is deduplicated; state/seq of an existing record are untouched.
- States: `open -> merge-pending -> verifying -> resolved`, with `needs-agent` for semantic/textual conflict
  or failed verification, and `cancelled`. Invalid transitions are rejected; terminal states are final.
- `nextForOutcome`: clean merge + passing verification auto-resolves (no GitHub issue); textual or semantic
  conflict, or a clean merge whose verification fails, needs the integration agent and **materializes one linked
  GitHub issue** (`linkGithubIssue` is exactly-once; a different number is refused).
- Merges are serial per repository: only the oldest non-terminal obligation (`head`) accepts `applyOutcome`.
- Human review and branch protection are untouched: this records and sequences, it merges nothing.

## Drift (#200)
`evaluateDrift(facts, policy)` -> `none | recheck-conflicts | replan | pause-for-human` from: base advanced,
lease expired, reservation expired/missing, unpredicted files, new overlap. Replans are bounded
(`maxReplans`, cooldown); beyond that it asks a human. An expired lease alone never silently continues.

## Pilot metrics (#202)
`predictionAccuracy` (precision/recall of predicted vs actual files), `conflictConfusion` (unknown kept apart from a
safe "none"), `rolloutSummary` (merge debt per completed item, throughput, deferral rate, regression flags vs baseline).
Rollout remains dry-run -> opt-in per project (`SchedulingConfig.enforce`) -> adaptive; the pilots in cezar-factory
and TableFlux still need to be run and recorded.

## Not here
Scheduler/event wiring of these modules, creating the GitHub issue itself, and the UI (#201).
