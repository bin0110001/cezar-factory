# Changed path impact collection (#118)

`scripts/collect-impact.ps1` compares two commit refs using their Git merge-base and emits a deterministic
changed-set JSON document. It reads the project's `.ai/factory/factory.config.yaml` and validates its
`verification` block with the same Zod contract and YAML parser used by Cezar.

Each added, modified, or deleted path includes its owning checks. A check owns a path when one of its
`verification.checks.<id>.owns` globs matches; each owner record also includes that check's `tags`. Paths
with no matching owner appear in `unowned`. Renames include both paths and resolve owners independently for
the old and new path. Git's NUL-delimited diff format preserves spaces and Unicode filenames.

The result includes `baseSha`, `headSha`, and `mergeBaseSha`, plus `added`, `modified`, `deleted`, `renamed`,
`paths`, and `unowned` arrays. The collector reports impact only. It does not choose or execute checks, and it
does not decide pass/fail. Its comparison uses committed Git history; working-tree and untracked changes are
outside the selected refs. Optional use can report `status: skipped` when the manifest or its `verification`
section is absent. Invalid YAML, an invalid verification contract, an unavailable ref, or histories without a
merge-base fail with an error.

Tests cover rename detection (including spaces and Unicode), ownership and tags, unowned paths, empty diffs,
missing refs, invalid manifests, and histories without a merge-base in `tests/collect-impact.ps1`.
