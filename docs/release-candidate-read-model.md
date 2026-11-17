# Release candidate read model (#631)

Read-only API for the Control Center: `GET /api/v1/workspace/release-candidates`. The contract is
`cezar/packages/contract/src/release-candidates.ts` (zod; types inferred), the builder is
`cezar/packages/cezar/src/release-candidates/read-model.ts`, and the typed client method is `getReleaseCandidates`.

The release engine (host) writes a snapshot at `~/.cezar/release/candidates.json` (`CEZ_HOME` respected, so no new setting); the service
validates and serves it. No snapshot is `available: false` with an empty list, not an error.

Per candidate: source dev SHA, revision, stable baseline, config hash, state, lease (with derived staleness), tests (status, shards,
asset version), dev drift, blockers, repair obligations, promotion receipts, the pending-trigger coalescing reason, next scheduled
attempt, PR and issue links, warnings, and the per-check matrix from the check pipeline (status, blocking, new versus known findings,
provider, feed freshness, scan scope, SBOM digest, active waivers; no raw evidence).

Guarantees: every string is redacted (token shapes and known secrets); unknown fields in the snapshot are dropped, so raw config never
reaches the model; a malformed candidate is skipped with a warning instead of blanking the view; each project has at most one active
candidate, and if a snapshot shows more the integrity violation is reported on the project and the candidate rather than hidden.

Gap noted: the host-side exporter that writes the snapshot from the candidate store is not part of this change; the UI work (#632, #633,
#634, #635) consumes this contract.
