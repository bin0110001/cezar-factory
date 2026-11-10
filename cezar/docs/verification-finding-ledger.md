# Verification finding ledger storage

`@open-mercato/cezar` stores each project's finding ledger at
`.ai/cezar/verification-ledger.json`. The ledger has a top-level `schemaVersion` and `projectId`,
and every finding, occurrence, episode, and alias repeats that project key. A store opened for a
different project refuses the file. The runtime rebuilds project/fingerprint, finding/occurrence,
finding/episode, and source-finding/alias indexes from validated records; the indexes are not
persisted as a second authority.

The file is atomically replaced under a `proper-lockfile` lock. Occurrences and alias/merge records
are append-only. An occurrence captures the result and run IDs, check attempt, tested commit,
environment, redacted diagnostics, evidence references, and one observation timestamp. Finding
summary timestamps and episode status have narrow update methods; a resolved episode cannot be
reopened in place. The recurrence/resolution policy remains in the verification ingestion layer.

The default retention period is 180 days for occurrences and resolved episodes. Active episodes
remain, with expired occurrence references removed. Finding identities and alias/merge decisions
remain so retained records keep their stable identity and human decisions stay auditable. The
retention period can be injected by a caller for policy and tests.

Schema version 0 is migrated on open: records receive the owning project's key, and legacy
observations receive `firstSeenAt`/`lastSeenAt` equal to their `observedAt`. Unknown future schema
versions and project mismatches fail closed. The data file, lock guard, lock directory, and atomic
temporary files are ignored by the project's Git state.
