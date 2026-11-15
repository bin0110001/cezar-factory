# Asset locality, staging and worker caches

Data-dependent jobs (licensed or project-private data, browser engines, Godot runtimes, shader caches, GPU
user-space runtimes) name what they need with **asset requirement descriptors**
(`schemas/asset-requirement.schema.json`). Asset payloads are never stored in Git or in the generic verification
core, and no licensed filename is hardcoded in Factory or Cezar: a descriptor carries a namespaced id, version,
`sha256` digest, source class (`public`, `project-private`, `licensed`), access scope, size, staging method,
cacheability, license restrictions and retention. Projects own the adapters; the Factory owns the policy
(`policies/asset-locality.json`) and the generic library (`scripts/asset-locality-lib.ps1`).

## Flow

1. **Preflight** (`Get-AssetPreflight`) runs in the scheduler before any reservation. Hard constraints make a worker
   `unschedulable:*`: `worker-offline`, `unauthorized` (missing scope for a non-public class), `adapter-not-allowed`
   (no allowlisted adapter for the staging method), `capacity` (cache quota or free disk). It returns the estimated
   staging bytes and cost; a cache hit lowers the cost and is only a soft preference.
2. **Stage** (`Invoke-AssetStage`) re-checks authorization, and only then resolves the adapter's credential. An
   unauthorized worker never receives a credential or content. Content is fetched to a private temp name, its digest
   and size verified, then published atomically under a cache key of `id|version|digest`. A changed manifest is a
   different key, so the stale entry of the same asset is evicted; least-recently-used entries are evicted to meet the
   quota.
3. **Run view** (`New-AssetRunView`) gives the run a read-only `assets/` view (the cache payload is read-only) and a
   separate writable `data/` directory.
4. **Evidence** (`New-AssetEvidence`) records id, version, digest, source class and cache state only. It must never
   hold payload bytes, source references, licensed filenames or worker paths, and must not be copied to generic logs,
   traces, public PR text or artifacts.

## Typed failures

`unschedulable:*` (worker cannot take the job), `infra:*` (`hash-mismatch`, `unsafe-path`, `disk-full`,
`access-revoked`, `stage-failed`) and `invalid:descriptor`. None is a test failure. A corrupt cache entry is detected
by digest, evicted and re-staged; if the source is unavailable the result is `infra:stage-failed`. Adapter error text
is not echoed, because it can carry credentials. Path traversal is refused for absolute paths, `..`, drive/UNC
prefixes and symlinks that leave the adapter root.

Jobs with no asset requirements never call this library, so non-asset and local-only execution are unchanged.
Renderer/driver/runtime-compatible shader caches are modelled as ordinary assets whose version includes that
compatibility, so an incompatible cache is a miss and rebuilds instead of failing a test.

Scope of this change: policy, schema, library and tests. Wiring the preflight into Cezar's scheduler (#198) and
the coordinated reservation (#217), and project-owned adapters, are separate follow-ups.
