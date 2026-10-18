Prerequisite decomposition from isolated source checks (no live checkout changes):

- #502 repairs the stale requirements-lint contract after the GitHub backlog cutover (four baseline failures on both `main` and `dev`).
- #503 reconciles the test manifest: 21 discovered suites lack entries and four entries are stale on `dev` (25 manifest failures total). This corrects my earlier shorthand that called all 25 unclassified.
- #504 is the separate high-risk GameSession extraction plan: 16,634 lines against the 16,047-line ratchet on `dev`, a 587-line violation. The ceiling must not be raised to make Factory validation green.
- #505 makes the quality command read-only by default. On the clean `main` clone, the command changed 20 tracked files even without the fix switch; those generated formatting-only edits were verified and restored in the isolated clone.
- #501 remains the high-risk live Godot/runtime and dirty-checkout rollout child.

The existing full/verify adapters must run these gates and report failure until the underlying baseline repairs pass; do not catch, ignore, or relabel their nonzero exits. `dev` and `main` have diverged substantially, so source PR base and release target must be explicit. #500 stays `factory:blocked` while the reviewed Factory timeout change, source repairs, and runtime path are unresolved.
