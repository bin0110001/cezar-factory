# Factory Control Center API contracts

These additive, versioned contracts describe the local controller API. Readers
build responses only from release manifests/state, controller SQLite rows,
activation receipts, promotion records, incident rows and optional worker
snapshots. Missing or stale evidence is represented as unknown, stale or
degraded. Responses never include host-absolute paths, credential values or
deployment log text.

- `read-model.schema.json`: aggregate projects, release channels, promotion
  stages, incidents and worker-slot/resource observations.
- `release-page.schema.json`: stable, bounded pagination over release records.
- `action-request.schema.json` and `action-receipt.schema.json`: typed,
  idempotent calls to the existing release controller operations.
- `audit-event.schema.json` and `event-page.schema.json`: append-only audit and
  change-feed records with an integer cursor.
- `access-config.schema.json`: local SHA-256 token hashes mapped to viewer,
  operator or release-admin roles.
- `worker-resources.schema.json`: optional structured worker sampler input.

Fixture values are synthetic. The all-zero/all-`a` digests in fixtures are not
credentials or deployable release artifacts.
