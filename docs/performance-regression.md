# Performance-regression policy

Issue #110 (parent #58, epic #47). A performance gate that sits **beside** the functional verification
result from the executor (`cezar/packages/cezar/src/verification/executor.ts`). It never changes a
`VerificationRun` status: a room build with valid geometry passes functionally and can still fail
performance. Both results are recorded separately.

Files: `policies/performance.yaml` (policy), `schemas/performance-policy.schema.json` (schema),
`cezar/packages/cezar/src/verification/performance.ts` (spans, fingerprints, evaluation, validation).

## Spans
`SpanRecorder.start(name)` / `end(name)` record a duration **only on measured completion**. An aborted or
still-open span is reported with no duration and can never satisfy a budget. Each start of the same name is a new
attempt; retries append and never overwrite the first (possibly slow) attempt. Tests inject a fake clock; never
sleep for real.

## Budgets
Per span: `absoluteMs` (every attempt must stay under it, so a slow first attempt still fails after a fast retry),
`medianMs` and `p95Ms` (over comparable baseline samples plus current attempts, requiring `minSamples`). All limits
must be positive and at least one metric is required; spans the policy does not list are rejected/inconclusive.

## Result states
`passed`, `failed`, or `inconclusive`. Inconclusive covers unfinished/missing spans, unknown span names, too few
samples, and a missing or uncomparable baseline. Inconclusive is never a pass.

## Environment fingerprint
A baseline is comparable only when every field in `fingerprintFields` matches exactly (default: `os`, `arch`,
`cpuModel`, `memoryClass`, `runtime`). A differing or missing field yields `comparable: false` with the reason and
mismatched fields; median/p95 are then not evaluated. Too many fields yields no comparisons, too few yields
misleading ones; change the list in the policy, not in code. Baselines are never rewritten automatically.

## Scope
No trend UI, history store, deployment, or executor-protocol change. The PerformanceResult is attached by callers
as an additive optional value.
