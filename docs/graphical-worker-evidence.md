# Graphical worker evidence and traceability (#328)

Validation is local only (`tests/run-tests.ps1` receipts, `docs/local-validation.md`); no GitHub Actions.
State as of this document: no `graphicalSession` code, ADR, fixture or test exists on `dev`. Every row below is
therefore an explicit coverage gap, to be replaced by a named test or evidence file when the sibling #328
children merge.

## Acceptance traceability
| #328 acceptance bullet | Test / evidence | Status |
| --- | --- | --- |
| Non-Godot rendered GUI fixture: real screenshot, renderer fingerprint, clean exit, no residue | none yet | coverage gap: fixture not merged |
| Project-owned Godot scene rendered with captured frame; headless tests unaffected | none yet | coverage gap: not merged |
| Software render path plus separately gated GPU pilot; unsupported hardware gap | `docs/graphical-worker-runbook.md` sections 3-4 (policy only) | coverage gap: no proof run |
| Parallel sessions on distinct displays; GPU/display contention deterministic | none yet | coverage gap: not merged |
| Crash/cancel/disconnect/fencing leak no sessions; local-only execution still works | none yet for graphical; existing suite covers local execution | coverage gap for graphical paths |

## Pinned dependencies
Not pinned yet: runtime, container image, driver and backend versions can only be recorded from a real run. Record
each as an exact version or image digest: Xvfb, Mesa, Podman, container image digest, GPU driver, Vulkan loader,
Godot (.NET and non-.NET), capture tool. This also feeds the baseline fingerprint (#110).

## Interfaces and downstream readiness
- #217 (multi-role sessions), #218 (caches), #219 (operator UI): consume the `graphicalSession` contract and
  capability statuses; interface not yet published.
- #329 and #330 can proceed in parallel once the session contract is stable. They are **not yet unblocked**,
  because the contract has not merged.
- Completion proof for #220: pending until the gaps above close; a comment linking this file is posted on #220.
