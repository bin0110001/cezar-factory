# Change Impact Manifest and overlap analysis (#195, #196; epic #192)

Code: `cezar/packages/cezar/src/server/impact/` (`manifest.ts`, `overlap.ts`).
Tests: `cd cezar/packages/cezar && CEZ_HOME=<tmp> npx vitest run src/server/impact`.

## Manifest v1 (output of #178 planning)
A zod-validated, revision-pinned *prediction*: issue, `repo{repository,branch,baseSha}`,
`manifestRevision`, `mode` (`code-first` low-cost pass, `spec-first` deeper), `planRef`/`specRef`,
`files[]` (modify/add/delete/rename, optional glob, `confidence`, `source` =
`code-graph|agent-hypothesis|human`), `modules[]`, `contracts[]` (interface, serialization,
network, build, migration, godot-resource; partial C# classes list every part file), `tests`,
`ownership`, `unknownZones[]`, `sensitiveGlobs[]`, `coverage` (`complete|partial|unknown`).

- Paths are normalised (forward slashes, no `./`); absolute and `..` paths are rejected, never invented.
- Identity is case-insensitive so Windows/macOS checkouts agree.
- A `complete` claim that declares `unknownZones` is downgraded to `partial`.
- `emptyManifest()` is coverage `unknown` ("we know nothing"), not "touches nothing".
- `isManifestStale(m, currentBaseSha)`: stale once the base advanced; unknown freshness = stale.
- `redactForScheduler()` replaces sensitive/licensed/secret paths with opaque hash ids that still match each other.
- Unsupported `schemaVersion` is rejected.

## Overlap (#196)
`analyzeOverlap(a, b, policy)` -> `none | unknown | module | file | contract` with confidence,
findings and per-side staleness. Rules:
- file overlap (case-insensitive; rename claims old and new path; globs lower confidence);
- shared contract id outranks file overlap;
- module-only overlap is a **warning** unless `elevateModules`; no dependency/blocker is ever inferred;
- unknown/partial coverage (or an unknown zone covering the other side's files) yields `unknown`, never `none`;
- stale manifests multiply confidence by `stalePenalty`; different repositories never conflict;
- findings never include sensitive paths.

`planBatch(candidates, policy, maxParallel)` takes candidates in dispatch-priority order,
never displaces an earlier one, admits a later one only if it is `none`/`module` against all chosen,
and reports `deferred` with the blocker. A lone unknown candidate still runs (no starvation).

## Not here
Persisting manifests in run storage (#126/#130), prompts/CLI validation, leases (#197) and
scheduler integration (#198). Those consume these pure functions.
