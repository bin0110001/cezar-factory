# GitHub workflow projection

Issue #767 (parent #761). Explicit workflow transitions replace implicit label control while GitHub issues and
pull requests stay authoritative for what only GitHub knows. It extends the lifecycle reconciler; it adds no
runner, store or policy authority. Code: `scripts/workflow-projection-lib.ps1`. Policy:
`policies/workflow-projection.json`. Records: `schemas/workflow-projection.schema.json` (`factory-workflow-projection/v1`).
Tests: `tests/workflow-projection.ps1` (registered in `tests/run-tests.ps1`).

## Direction and precedence

| Concern | Authority |
|---|---|
| Workflow state (implementing, reviewing, ...) | Factory run state. Labels are a projection of it. |
| PR approval, merge status, branch protections | GitHub only. |
| A manual label edit on an automated state | Drift: re-projected from run state. |
| A manual label edit on a human-owned state (`waiting-human`, `waiting-human-review`, `blocked`) | Accepted as a human signal and not overwritten. |

Approval is satisfied only by a non-bot maintainer review on the current head with no later changes-requested and
satisfied protections. A label (even one named "approved") or an OCR/automated clean review never satisfies it.
Unreadable review state is `UNKNOWN` (`approval_unverified`), never assumed.

## Convergence

- Inbound events become typed signals, deduplicated by `eventId` and ordered by (timestamp, eventId), so missed,
  duplicated and reordered input produce the same result.
- Every projection write carries an idempotency key (`issue|state|revision`, SHA-256) and a marker; events Factory
  itself authored (actor or marker) are never inbound signals, so label changes cannot ping-pong.
- Reconciliation is level-triggered: a pass compares desired and observed labels and publishes only the difference.
  A second pass with the same input is a `noop`.
- Enabling records a baseline watermark; events at or before it never admit work, so historical implementation and
  fix jobs are not replayed.

## Outage, restricted writes, webhook loss

Factory execution continues from its own state. A projection that cannot be written is `queued` (`api_outage`) or
`waiting` (`restricted_write`) with evidence text from the policy, and publishes idempotently on recovery. No events
for longer than `staleEventSeconds` is `unknown` (`webhook_loss`), prompting a level-triggered resync. These records
are the read-model evidence the UI shows.

## Migration

`policies/workflow-projection.json` `labelToState` (`mappingVersion` 1) maps each `factory:*` label to a workflow
state. `New-MigrationReceipts` emits one receipt per issue (ambiguous labels map to `unknown`) with
`admission: none`. Existing label lifecycle keeps working during the phased migration; see [lifecycle.md](lifecycle.md)
and [backlog-reconciler.md](backlog-reconciler.md).

## Known gaps

The projection library is pure and tested with fixtures; wiring its plans into the reconciler's GitHub writes, and
adapting to the workflow-contract and hierarchical-runtime state shapes from sibling #761 issues, is follow-up work.
