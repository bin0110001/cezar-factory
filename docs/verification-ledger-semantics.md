# Verification ledger: recurrence, resolution and overrides

Implemented in `cezar/packages/cezar/src/verification/finding-ingest.ts` on top of
`FileFindingLedgerStore` (finding-ledger.ts) and the fingerprint module.

- **Ingest**: a failed check with a fingerprint matches a Finding by project + fingerprint
  (following merge/alias links) or creates one, appends an immutable Occurrence, and
  appends to the open Episode or opens one. Intermittent results stay on one Finding.
- **Recurrence**: a reproduced resolved Finding opens a NEW Episode; the earlier one is untouched.
- **Resolution** (`evaluateResolution`): only an explicit, valid, relevant, comparable
  (platform/arch), passing check run newer than the last observation resolves an Episode.
  Omitted, skipped, no-tests, unknown, truncated, infrastructure-error, zero-coverage or
  irrelevant checks never resolve. Reason and evidence are recorded in the audit log.
- **Overrides**: merge, alias, split, manual resolve and reopen are appended to
  `verification-ledger-audit.jsonl` with actor, reason, time and prior state. State is derived
  only by the pure `reduceAudit`; `replayAudit` from empty equals the live state.
- Time comes from event data (`finishedAt` / `at`), never the wall clock. Every entity is
  project-keyed; audit events for another project are rejected. No GitHub or Hindsight writes.

## Dispositions and trusted baseline comparison (#664)

`disposition.ts` adds a per-run **Disposition** next to the immutable Occurrence and the
persistent Finding/Episode, stored in the same ledger file (`dispositions`, `waivers`; additive,
older files load with empty arrays) and summarised in the same audit log (`disposition-recorded`,
`waiver-granted`). Each record carries the decision, evidence refs, effective policy version,
base SHA, environment fingerprint, actor and event time.

- **Classes**: `new`, `known`, `worsened`, `resolved`, `reopened`, `untested`, `unknown`, `infra-failure`.
  Baseline 42 warnings, run reports 39: 39 `known`, 3 `resolved`, none `new`.
- **Trusted baseline** (`resolveTrustedBaseline`): only integration-branch evidence
  (`policies/verification.json` `dispositions.integrationBranches`) or evidence approved by a
  `policies/baseline-promotion.json` approver who is not the run author. The run's own branch or commit
  is never a baseline, so a feature-branch rerun cannot make a new failure `known`.
- **Never a pass**: no trusted baseline, stale baseline, changed environment fingerprint
  (`environmentKeys`), missing required suite or incomplete selection -> `unknown`/`untested`;
  runner crash/timeout/cancel -> `infra-failure`. `passable` is true only for a complete,
  comparable run with no blocking disposition.
- **Known is not waived**: a waiver (`grantWaiver`) is a separate record, scoped to explicit
  branches and a fingerprint, expiring (max TTL from policy), granted by a permitted approver who is
  neither the requester nor the run author. Only `new`/`worsened`/`reopened` can be waived.
- **Replay**: output is a pure function of the supplied inputs (ids are hashes, lists sorted, time
  from event data), so replaying the same ledger and audit inputs is byte-identical.
- `scripts/acceptance-ledger.ps1` `ConvertFrom-BaselineComparison` accepts an optional
  `dispositions` map; blocking classes fail, unknown/infra-failure/untested are inconclusive.
