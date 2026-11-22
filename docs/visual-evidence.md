# Visual evidence: verification API, gallery and operator policy

Issue #354 (epic #330). Visual evidence rides the **existing** verification contract
(`verificationArtifactRefSchema.visualEvidence`, `cezar/packages/contract/src/verification.ts`) and the existing
content-addressed coding-run artifact store. There is no evidence database or duplicate media store. Captures
stay outside the worktree and are never copied into traces, prompts, issue comments or PR payloads. The reference
and verification metadata are recorded on the owning check.

## Capture adapters

`VerificationAdapterContext.createSessionArtifactSaver()` returns the existing `saveArtifact` callback shape used
by Playwright and desktop session controls. It binds each screenshot, WebM recording or Playwright trace to the
current verification ID, check, attempt, source commit and manifest digest. The adapter declares required
role/checkpoint pairs with `expectVisualEvidence()`; missing, failed or invalid captures downgrade that
check to incomplete/unknown, even if adapter code catches a storage error. Desktop session controls route
screenshots and recordings through `saveVisualArtifact` while file downloads retain their ordinary artifact path.
Recording requests accept bounded frame rate and quality, and the backend receives hard duration and byte limits.

The capture store rejects empty, oversized and signature-mismatched media. Binary capture callers must explicitly
assert the bytes were inspected for redaction. Reads verify metadata, expiry, byte length and SHA-256 before serving;
the existing local-operator, project access, redaction and preview limits still apply.

## API

| Route | Purpose |
| --- | --- |
| `GET /verification/evidence/:runId?commitSha=&roles=` | Revision-bound metadata: commit, manifest, policy versions, per-test outcome, items, time-ordered timeline. |
| `GET /verification/evidence/:runId/:artifactId/content?disposition=preview\|download` | One item's bytes. Re-checks access, redaction, size and the recorded sha256 on every read. |
| `GET /verification/artifacts/:runId/:artifactId` | Text artifacts only. Visual evidence answers 403 here so the text path cannot bypass redaction. |

Outcomes are `passed`, `failed`, `incomplete`, `inconclusive`, or `null` with `state: "none"` when a run recorded no
visual evidence at all (feature disabled, headless, missing backend). Missing evidence is never a pass:

- **incomplete**: no capture, a required role (`roles=host,guest`) has no capture, a capture is invalid, or a baseline exists without an actual.
- **inconclusive**: the check did not finish, the baseline renderer is not comparable (`rendererMismatch`), or the
  requested `commitSha` differs from the evidence's commit (`state: "stale"`).
- **failed** / **passed**: only from the deterministic check status over complete, comparable captures.

Roles `expected`/`baseline` and `actual` mark the comparison sides, kind `diff` is the pixel diff; any other role is a
session role (for example `host`, `guest`) shown time-aligned in the timeline.

## Access and redaction (checked separately for metadata, preview, download)

| Evidence | Metadata | Preview | Download |
| --- | --- | --- | --- |
| `accessPolicy: private` | local operator only (others see a `withheld` count, content answers 404) | local operator, if redacted | local operator, if allowed below |
| `redactionState: redacted` | yes | PNG up to 1 MiB | yes (up to 50 MiB) |
| `redactionState: unredacted` (possibly licensed) | yes | never | local operator only |
| `redactionState: unknown` | yes | never | never |

The local operator is the same `localHandoff` capability that guards other operator-only actions. Content responses
are `nosniff`, `Cache-Control: private, no-store`, sandboxed by CSP, and downloads are attachments.

## UI

The verification history run detail shows a **Visual evidence** section (hidden when `state` is `none`): expected /
actual / diff frames per test, role captures, withheld and missing-role notices, downloads where allowed, and a session
timeline sorted by capture time. It links back to the test and role through `testId`, `role` and `sessionId`.

## Fixtures

`verification/visual-evidence-fixtures.ts` builds a browser (Chromium headless) and a Godot rendered-scene (Xvfb,
llvmpipe) run through the same `compareVisual` path and artifact contract, writing real PNGs. They back
`visual-evidence.test.ts` (outcomes, stale revision, incompatible baseline, unauthorized access, digest tamper).

## Reference baseline policy

- The policy (`verificationVisualPolicySchema`: tolerance, max diff ratio, masks, max masked ratio) is pinned on the
  protected branch; a project agent cannot supply it. A baseline approved under another policy is `inconclusive`.
- Baselines are keyed per adapter (`playwright/<project>/<test>/<name>` or `generic/<test>/<name>`), carry
  provenance (commit, reason, approver, optional sign-off) and are only compared against a matching renderer
  fingerprint (OS, resolution, DPI, backend, renderer, API, driver, app version).
- Relaxing a policy or replacing an approved baseline needs a distinct permitted reviewer (`authorizeChange`).
- Retention follows each item's `retention` value; expired media answers 410 and the record stays as metadata.

## Pilot

The graphical-worker pilot (#220) and its status are in [graphical-worker-evidence.md](graphical-worker-evidence.md);
local pilot captures use this same artifact contract, so they appear in the gallery with no extra wiring.
