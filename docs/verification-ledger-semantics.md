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
