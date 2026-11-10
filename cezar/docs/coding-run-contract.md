# Coding run, attempt, event and evidence contract

This document defines the additive v1 contract family in `@open-mercato/cezar-contract`.
It gives a shared vocabulary to issue/PR lifecycle consumers and verification evidence without
introducing another persistence system.

## Ownership boundaries

- `codingRunRecordSchema` describes the source issue, project, base revision, run status, and
  observed execution identities. It does not own the existing Cezar API run record.
- `codingAttemptRecordSchema` describes one bounded execution attempt and its retry lineage.
- `codingRunEventSchema` describes append-only lifecycle facts. The event store and projections
  are owned by the execution-ledger work, not by this contract.
- `codingEvidenceReferenceSchema` points to verification results, findings, artifacts, commits,
  diffs, or review records. It can link findings, occurrences, and episodes by their canonical
  identifiers and never embeds their content.
- The verification contract remains authoritative for verification IDs and check results.

This family defines a single issue run, not an agent DAG. `runId`, `attemptId`, and `eventId` are
distinct identities. `correlationId` groups the run's events; `causationEventId` links an event to
an earlier event. Attempt indexes are contiguous and retries name the attempt they supersede.

## Lifecycle event vocabulary

The v1 vocabulary covers run and attempt start/terminal events, context preparation, implementation,
validation, repair, delivery, and learning records. An event has a monotonic sequence, an ISO
timestamp, a run correlation ID, and zero or more evidence references. Events carry typed lifecycle
metadata only; prompts, model output, credentials, and raw artifacts are not event payloads.

## Explicit availability

External metadata is represented as `available` with a typed value, `unknown` when it was not
observed, or `unavailable` when its source could not be read (with a reason code). This avoids
placeholder values such as `"unknown"` being mistaken for real worker, model, or revision IDs.
Prompt and skill content are represented by SHA-256 digests only.

## Versioning and compatibility

The snapshot and each record use numeric `schemaVersion: 1`. V1 schemas are strict and bounded.
Optional fields allow declared v1 metadata while preventing misspelled or secret-bearing fields from
silently entering records. `parseCodingRunSnapshot` returns `valid`, `invalid`, or `unknown-schema`;
readers must not reinterpret an unsupported version as v1. A future incompatible shape gets a new
version and an explicit migration at its storage/transport owner. This package does not migrate or
persist records.

## Example

See `packages/contract/fixtures/coding-run/lifecycle-v1.json` for a full run with two attempts, a
repair, validation links, PR delivery, and explicit unknown model subscription metadata. The fixture
is validated by `coding-run-contract.test.ts`.
