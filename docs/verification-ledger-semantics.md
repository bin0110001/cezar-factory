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

## Dispositions and stage minimum gates (#665)

`scripts/release/verification_disposition.py` turns normalized outcomes into a disposition per stage
(`policies/verification.json` → `stageGates`, schema `schemas/verification-policy.schema.json`).
Rules, first match wins: unrecognized input → BLOCK; pass → CONTINUE; outage → RETRY until
`maxOutageRetries`, then BLOCK with `escalate`; unknown coverage → RECORD (status `unknown`, never pass), or BLOCK when the
check is a stage `requiredChecks` entry; acceptance-impacted failure → BLOCK; new focused regression → BLOCK; accepted
unchanged debt → CONTINUE; severity at or above `blockAtOrAbove` → BLOCK; otherwise RECORD (follow-up).
The stage verdict is the worst disposition; an absent required check BLOCKs.
`protectedPaths` lists the policy, schema, baseline and waiver files an implementation change may not edit
(`reject_implementation_change`); `policies/baseline-promotion.json` protects the policy for `check-weakening.ps1`.
Assumption: the separate disposition-model sub-issue is not yet present, so the enum lives in this module. Outage retry
bounds are per stage and stay within the repair loop's attempt caps. `agent_summary` and `ui_payload` give the concise agent
text and the plain data block for the existing Verification query/UI; no new store is created.
