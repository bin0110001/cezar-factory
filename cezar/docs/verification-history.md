# Verification history

The project-scoped cockpit page reads the shared, version 1 verification query envelope through
`GET /api/v1/p/:projectId/verification/query`. It supports the `runs`, `selected`, `deferred`,
`failures`, `episodes`, `artifacts` and `baseline` query kinds, keyset pagination, bounded text,
redacted excerpts and lazy artifact references. Per-check durations and metrics are optional fields
on `runs` items; older records without them still render.

The query adapter reads the existing Cezar run event store. New verification events include the
contract-validated result, selection reasons and suite name, so run details remain available after
the task worktree is reclaimed. The adapter does not create a second history store. As with other
Cezar run history, task deletion and run-store retention remove old records; the store keeps a
bounded number of archived and unarchived tasks.

Artifacts remain in the task worktree. Large artifacts are returned as reference-only items and
loaded on demand. The endpoint verifies path containment and the recorded SHA-256 before returning
redacted text. A reclaimed worktree makes its artifact unavailable (HTTP 410), while the run and
check history remain visible. Selection reasons explain suite membership; no separate test-impact
selector is implied by this executor.

The verification contract also accepts an optional `visualEvidence` descriptor on a check artifact.
Version 1 binds the artifact hash, verification ID, check attempt, test ID, commit, manifest, and
storage path. It records the worker and renderer fingerprint, capture time, retention and access
policy, and redaction state. Visual evidence must belong to a check so the contract can reject
cross-attempt or cross-test mixing. Legacy artifacts and headless runs without descriptors remain
valid; this metadata contract does not enable graphical execution or change artifact retention.

Failure recurrence uses the check's stable `findingFingerprint`. The executor derives one from the
check identity and its diagnostics, falling back to normalized output when diagnostics are absent.
The read view classifies a fingerprint with one recorded occurrence as new, repeated occurrences as
known, and failures without a fingerprint as unknown. An episode is shown as resolved when a later
run of the same check passes. These are read-only projections over retained run events; they do not
change verification or baseline policy.
