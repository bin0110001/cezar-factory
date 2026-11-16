# Candidate-scoped verification and evidence validity (#593)

`scripts/release/release_verification.py` (library only) reuses existing verification for a frozen candidate revision.
Workers, local or the distributed ones (#213), run the tests; they report into these structures. No GitHub Actions
compute is involved.

- **Manifest.** `build_manifest` freezes the full candidate SHA (a branch name is refused), revision, each suite's
  adapter version and selection hash, and the config, asset and environment hashes, plus an advisory refresh id. A
  manifest hash makes any change visible.
- **Evidence is stamped with its key.** `evidence_record` records candidate, revision, SHA, adapter version, selection
  hash, config/asset/env hashes and, for advisory-bound suites, the advisory refresh. `evidence_problems` names every
  dimension that no longer matches (`sha-changed`, `configHash-changed`, `advisory-refreshed`, `expired`, ...).
  Evidence from another revision or SHA can never satisfy promotion. An advisory refresh invalidates only advisory-bound
  suites even when the source SHA is unchanged (the independent CVE refresh of #599/#600).
- **Gate.** `gate` requires every required suite to have valid, passing evidence for the exact manifest. Missing,
  expired, invalid, failed, `unknown` or `error` evidence blocks (a scanner outage is not a pass); optional suites never
  block. Known debt counts only when the caller opts in.
- **Classification.** `classify` separates infrastructure failure, known debt, flaky, genuine regression and `unknown`.
  Reruns are bounded; an infrastructure failure that outlasts them is `unknown`, never a pass.
- **Incremental revalidation.** `plan_revalidation` reuses a prior pass only when provably safe: same adapter, selection,
  config, assets, environment and advisory refresh, every changed path covered by the impact map and not touching the
  suite, a valid passing prior result, and the suite is not `mandatoryFull`. Anything else runs in full, and a mandatory
  full regression is never skipped.
- **Shards and nodes.** `resume_plan` reruns only missing, failed or invalid shards. `assert_uniform` checks that mixed
  nodes used one SHA, revision, asset/env hash and resource digest, and that each checked out the candidate SHA rather
  than a mutable branch. `EvidenceCache` is keyed by the immutable evidence key with explicit expiry.

Check-provider results (`docs/check-provider-contract.md`) feed this gate as suites: their `unknown` and `error`
statuses block a required suite. A scheduled periodic scan produces evidence only and never a second candidate.
