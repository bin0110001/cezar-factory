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

## Operator actions (#634)

`POST /api/v1/workspace/release-candidates/actions` accepts `create`, `pause`, `resume`, `cancel`, `abandon` and `retry`. It never
changes candidate state: it validates the request against the published snapshot and appends an audited request to
`~/.cezar/release/actions.jsonl`, which the host release engine consumes and applies through its lifecycle state machine
(`status: queued`). The checks, in order: local machine only (a remote cockpit gets 403); a snapshot exists and the project is in it;
`create` is refused with a clear message while the project has an active candidate (the one-active rule); the action names the
active candidate and is valid in its state (`retry` needs a candidate in repair, or restarts the last failed one when none is
active); and `cancel` and `abandon` require the operator to type the candidate id (`confirm`). Every accepted action writes one audit
entry (id, time, actor, action, project, candidate, redacted reason, snapshot time); if it cannot be written the action is not accepted.

Gaps: the host engine's consumer of `actions.jsonl` is not part of this change; UI buttons and the confirmation dialog are not built
yet (the endpoints and the client method `postCandidateAction` are the contract for them).

## History, audits and metrics (#635)

Read-only views in the existing Control Center (`packages/web/src/routes/release-metrics.tsx`), backed by
`GET /api/v1/workspace/release-history` and `GET /api/v1/workspace/release-metrics`
(`src/release-candidates/history-metrics.ts`). No new permission is needed to read; the actions that change anything stay local-only
(`docs/release-candidate-read-model.md`, `docs/release-pipeline-config.md`).

**History** merges the operator-action audit (`actions.jsonl`) and the policy-change audit (`pipeline-policy-audit.jsonl`), newest first,
with candidate rows from the snapshot. It respects retention: each project's window is its effective `artifactRetentionDays` (default 30
days); older audit entries and terminal candidates are omitted, active candidates always show. A damaged audit line is skipped, not fatal.
Reasons are redacted.

**Metrics**, per project, only from recorded data (`timing`, `cost`, obligation `openedAt`, receipts, scheduled-check and AI-audit
records in the snapshot). A figure with no recorded input is `null` with zero samples and the UI says "not recorded"; nothing is estimated.

- Queue wait: queued to admitted, mean and worst, in minutes.
- Suite cost: compute hours, total and mean.
- Regressions: candidates that needed a repair revision (revision above 1) out of the candidates counted.
- Forward-port lag: age of the oldest unresolved obligation that recorded when it opened, and how many are unresolved.
- Stable age: hours since the latest successful promotion receipt.
- Scheduled checks: independent periodic runs, how many failing, the last run.
- AI audit (opt-in): runs, skips, dollars and tokens, so an operator sees why it ran or was skipped and what it consumed.

The snapshot contract gained optional fields for this (`timing`, `cost`, `openedAt`, `scheduledChecks`, `aiAudit`); the engine-side
exporter that fills them is not part of this change, so an older snapshot simply shows "not recorded".

## Quality actions (#603)

Server side of the quality and security view; the check matrix, known versus new findings, feed freshness and waiver counts per candidate are
already in the candidate read model (`docs/release-candidate-read-model.md`), and the independent scheduled-check history and AI audit cost are
in the metrics.

- `POST /api/v1/workspace/release-quality/dry-run`: applies a `quality-gates/v1` policy (usually the one being edited) to the last candidate's
  check matrix at every stage (pr-dev, candidate, stable, periodic, manual) and returns what would block, per check, with its level, its
  `onUnavailable` mode and a note. A failed scan (`error`, fails closed) and a confirmed new blocking CVE (`fail`) are different statuses, so
  they stay distinguishable, and a required check with no result counts as `unknown`, never a pass. It also returns the recorded compute cost
  as an estimate (or says none was recorded) and warns when a scanner feed is stale or unavailable. It saves nothing. An invalid policy is refused
  with error paths, including the rule that a required security check must fail closed at a promotion stage.
- `POST /api/v1/workspace/release-quality/waivers`: a review-only waiver request. It must name a fingerprint or an advisory, the stages it covers, a
  reason of at least 10 characters and an expiry (no blanket or open-ended waivers), and it is refused above the maximum lifetime (30 days here; the
  engine applies the policy's own maximum when it records the waiver), for an unknown project or candidate, and from a remote cockpit. An accepted
  request appends one redacted, audited entry (`~/.cezar/release/waivers.jsonl`, reviewer kind `operator`) and is queued for the engine; this view
  never grants a waiver itself. Waiver requests appear in the history view.

`isBlocking` and the stage matrix are a TypeScript port of `scripts/release/quality_gate_policy.py`. `tests/fixtures/quality-gate-cases.json` is generated
from the Python library (every category, stage and status for the shipped policy and for an override case); both the Python and the TypeScript tests check
it, so a dry run agrees with the gates. After changing the Python rules, regenerate the fixture and fix the port until both pass.

Gap: the UI forms (waiver request, policy dry-run table) are not built; the endpoints and the client methods `requestWaiver` and `dryRunQualityPolicy` are their
contract. Pilots on real projects and the scanner-swap trend over time need real runs; swap-preserves-history is covered by `provider-swap-ledger.test.ts`.
