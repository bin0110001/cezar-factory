# Coding run ledger

Coding run history is stored in the repository's existing workspace lifecycle registry at
`$CEZ_HOME/workspace-lifecycle/<repo-id>/registry.sqlite`. The registry's `events` table is
the append-only audit source. `coding_runs` stores the canonical run record and a rebuildable
projection; `coding_run_evidence` stores evidence references in the same transaction as the
event that first references them. Run events use the event table's `execution_id` column for
the coding run ID and retain their per-run sequence in the validated event payload.

`createCodingRun` writes the initial run record and `run.started` event atomically.
`appendCodingRunEvent` validates the next transition, inserts any new evidence references,
appends the event, and updates the projection in one SQLite transaction. A failed insert or
projection update rolls back all of those writes. `rebuildCodingRunProjection` replays the
ordered run events against the canonical record and persisted evidence, then replaces the
projection. This makes the projection disposable and provides a recovery path after corruption.

Opening the registry migrates it to schema version 4 in place. Existing lifecycle events and
telemetry outbox records remain in the same database. Operational `runs.json` and NDJSON
traces remain separate compatibility/debug outputs; they are not authoritative for ledger
replay. No external database service is required.
