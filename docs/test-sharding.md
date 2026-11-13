# Portable test sharding (#216, epic #213)

Code: `cezar/packages/cezar/src/server/verification/` (`shard-manifest.ts`, `shard-planner.ts`,
`shard-aggregate.ts`). Tests: `cd cezar/packages/cezar && npx vitest run src/server/verification/shard-planning.test.ts`.

Sharding is **opt-in**. Without `optIn`, or when the project adapter reports `discovery: 'unsupported'`,
the plan is a single `full-suite` partition that runs the project-owned command
(`fullSuiteCommand`); it is verified only by a fresh, zero exit code.

## Manifest v1
Per test: stable `id`, `isolationGroup`, `parallelSafe`, `shardable`, `setup`/`teardown`, `mandatory`,
`idempotent`, `durationMsOverride`, `requires` (the #112 job requirements: OS, GPU, display, renderer),
`protected`. Defaults are conservative: not parallel-safe, not idempotent, mandatory. Framework
discovery stays in project adapters; graphical cases are ordinary tests with `requires` set.

## Planner (pure, no LLM)
Inputs: manifest, selected tests (#53), workers (id, environment key, capabilities), per-environment
duration history, commit, policy revision. Mandatory tests the selection omitted are added
(`mandatory-added`). Tests sharing an isolation group or setup, and all non-parallel-safe tests,
form one serialized unit. Units go longest-first to the least-loaded compatible worker; an extra
worker is used only when the predicted gain exceeds the per-partition overhead. Duration source is
override, then compatible-environment history, then a fixed default. The output is a frozen plan
with a content-derived `planId`, commit/manifest/policy revisions, per-test reason codes and
`unplaceable` tests (no compatible worker, e.g. a render test and no display: never run headless).
Identical inputs give an identical plan.

`reassignPartition` moves only a never-started partition; `planRetry` allows a new attempt only for
all-idempotent partitions, bounded by `maxAttempts`.

## Aggregation
`aggregateShardResults` accepts a result only if plan id, commit, manifest revision, partition and
current attempt match and it is not late; otherwise it is `rejected` with a reason. Identical
duplicates collapse; conflicting duplicates make the partition `inconclusive`. Each expected test gets
a ledger entry (`pass|fail|skipped|untested|canceled|infra|inconclusive`) with attempt, worker and
environment lineage and artifact hashes. Verdict: any failure `fail`; else any infra/crashed
`infra`; else anything but pass on a mandatory test `incomplete`; otherwise `pass`. A missing,
canceled, crashed or late partition can never produce `pass`. The report carries serial time, wall
time, queue/transfer overhead and the measured speedup.

## Not here
Persistence in the evidence store (#52/#106), remote transport (#113) and the adapter implementations
consume these pure functions. Stateful multi-role scenarios are #217, not sharding.
