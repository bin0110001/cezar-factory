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

## Isolated scanner worker profile

Scanners run under `server/verification/scanner-worker-profile.ts` (#605). The profile describes a
rootless, unprivileged worker: source and artifact mounts are read-only, scratch is `noexec` tmpfs,
all capabilities are dropped, and the environment is built from an explicit allowlist (a
credential-like name in the allowlist is refused). The network is `none` except in the `db-update`
phase, which needs a non-empty advisory-DB host allowlist and an enforceable egress control.
Isolation that cannot be enforced fails closed with a reason: Windows has no native read-only mount
or egress primitive, so it requires a container runtime, as does Linux. Scanner logs, findings and
artifact text pass through `core/secret-redaction` (plus caller-supplied literals such as a planted
fixture secret) before the ledger ingests them. No new CI/runner engine is added; the argv is run by
existing Factory-managed workers.
