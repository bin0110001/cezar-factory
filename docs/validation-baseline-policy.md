# Validation baseline and merge policy

Pinned diagnostic baselines explain project test output; they do not waive a
required validation result. Full and verify stages must still produce clean,
current-head receipts with `status: passed` and `exitCode: 0` before merge
eligibility can succeed. A failed stage remains a merge blocker even when every
reported fingerprint is present in the baseline.

Known fingerprints are labeled as pre-existing for diagnosis. New fingerprints
and unclassified diagnostics remain visible and require investigation. A
missing, expired, changed, untracked, or provenance-invalid baseline is
`unavailable`; the comparison must not hide diagnostics or change the test
verdict. Updating a baseline requires a separately reviewed project change
with a new hash pin, provenance, reason, and expiry. Baseline updates cannot
land in the same implementation change whose failures they classify.

This policy does not grant exceptions for known failures. Any future exception
mechanism needs an explicit policy change, named owner, scoped checks, and an
expiry before the merge gate can accept a non-passing full result.
