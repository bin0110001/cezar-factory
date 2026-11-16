# Immutable regression snapshots (#592)

`scripts/release/release_snapshot.py` turns regression into a frozen, testable snapshot instead of a branch that
keeps receiving merges. Library only; the candidate store (`docs/release-candidate-store.md`) records the SHAs it
returns, and the verification and promotion stages consume them.

- **Immutable reference.** `create_snapshot` freezes a full dev SHA as `refs/rc/<id>/<revision>` with a create-only
  compare-and-swap. The same SHA again is idempotent; a different SHA for the same ref is `immutable-ref-conflict`.
  Branch names and abbreviations are refused, because they are mutable or ambiguous. The stable base must be an
  ancestor of the snapshot (`diverged-stable` otherwise), so promotion stays a fast-forward.
- **No force updates.** Every write is `update-ref <ref> <new> <expected-old>`. The optional regression branch pointer
  moves only if it still holds `expected_pointer` (`writer-drift` if someone else moved it) and only as a
  fast-forward (`non-fast-forward` unless `allow_pointer_rewind`, which is still a compare-and-swap). The immutable
  ref is created first and survives any pointer refusal. With `regression_branch=None` no branch is touched, which
  covers the opt-out and the legacy two-branch mode; branch names are data.
- **Manifest.** Candidate id, revision, SHA, stable base, config hash (`docs/release-pipeline-config.md`), caller
  supplied artifact/asset/environment fingerprints and a manifest hash.
- **Recovery.** `verify_snapshot` reports `ok`, `ref-missing` or `ref-moved`. A deleted ref is recreated from the
  recorded SHA by `recover_missing_ref`; a moved ref is blocked and never overwritten.
- **Repairs.** `derive_revision` requires the repair SHA to descend from the current candidate with no merge commits,
  so the latest dev is never merged into an active candidate and revisions are sequential.
- **Promotion provenance.** `provenance` ties stable to the exact tested SHA and refuses evidence for another SHA.
- **Cleanup.** `cleanup` only runs for a terminal candidate, returns an audit list of every ref and SHA before deleting,
  keeps a promoted candidate's final ref, and leaves any tampered ref for an operator.

Not here: the dev merge queue (#199) keeps merging as before; the integration coordinator receives the candidate
context from the caller. Retention periods are the caller's policy input to `cleanup`.
