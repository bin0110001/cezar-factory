# Langfuse operations

The Bazzite control-plane Compose project runs the official Langfuse v4 web and
worker images with PostgreSQL, ClickHouse, Redis, and MinIO. Image release and
stateful component versions are explicit in `integrations/bazzite/env.example`;
MinIO uses an immutable amd64 manifest digest.
The composition follows the [official Docker Compose deployment](https://langfuse.com/self-hosting/deployment/docker-compose)
and [upstream Compose source](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml);
the Langfuse image tag is `4.78`, checked on 2026-11-10.
The web UI is bound to loopback port 3002; MinIO API and console are bound to
loopback ports 9090 and 9091. The databases and worker have no host-published
ports. Cezar sends OTLP/HTTP to `http://langfuse:3000/api/public/otel/v1/traces`
using its host-local project keys and the v4 ingestion header.

## Secrets and access

Copy `integrations/bazzite/env.example` to the host-only
`integrations/bazzite/.env`. Generate separate long random URL-safe values for
`LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_SALT`, the PostgreSQL, ClickHouse, Redis,
and MinIO passwords, and the Langfuse project secret. Generate
`LANGFUSE_ENCRYPTION_KEY` as exactly 64 hexadecimal characters. Keep `.env` out
of source control and limit access to the operator account. `LANGFUSE_HOST`,
`LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` are the Cezar outbox settings;
they are not injected into Langfuse's web or worker environment.
Set `CEZ_WORKER_ID` to a stable unique value on each Cezar host so the
allowlisted `worker.id` attribute distinguishes multi-host spans.

Only the web UI/API is reachable from the host network, on loopback. Keep the
MinIO ports loopback-only: media URLs use the operator's `localhost:9090`
endpoint while Langfuse uses the internal MinIO endpoint for storage. Do not
publish PostgreSQL, ClickHouse, Redis, or worker ports. A trusted reverse proxy
or remote OTLP source needs a separately reviewed TLS and access-control plan;
do not bind these ports to `0.0.0.0` as a shortcut.

## Data and capacity

Persistent named volumes hold PostgreSQL metadata, ClickHouse events and logs,
Redis queues, and MinIO event/media blobs. Redis is operational queue state and
must be quiesced or drained before a consistent backup. Keep all five volume
sets; `podman compose down -v` destroys the stored traces and is not a routine
upgrade command. Langfuse's Compose deployment is a single-node setup without
built-in high availability or backup orchestration.

The initial project is configured for 90-day event retention through
`LANGFUSE_INIT_PROJECT_RETENTION`. Langfuse's [data retention feature](https://langfuse.com/docs/administration/data-retention)
is available on self-hosted Enterprise; without that entitlement, data remains
indefinitely by default. Existing projects do not pick up the init setting and
need an owner or admin to configure retention through project settings or the
Organization Management API. Keep MinIO event/media objects aligned with
Langfuse retention; bucket lifecycle deletion can break references and is not a
substitute.

The upstream sizing guide lists per-service minima of 2 CPU/4 GiB for web,
worker, PostgreSQL, and MinIO; 2 CPU/8 GiB for ClickHouse; and 1 CPU/1.5 GiB for
Redis. That totals about 25.5 GiB if those independent minimums are allocated
simultaneously. Treat it as a capacity warning, then measure this low-volume
home deployment before setting container limits. The upstream VM quick-start
suggestion of 4 cores, 16 GiB memory, and 100 GiB disk is a starting point, not
a guarantee for every ingestion rate. Monitor disk growth and queue health.
The read-only Bazzite check on 2026-11-10 reported 22 GiB total memory, 13 GiB
available memory, and 2.5 GiB free on `/var/home`. That free space is too small
for a safe fresh stack pull and restore rehearsal; recheck capacity before the
scratch run and keep adequate headroom for normal host operation.

Langfuse's [backup guidance](https://langfuse.com/self-hosting/configuration/backups)
and [sizing guide](https://langfuse.com/self-hosting/configuration/scaling)
should be rechecked before each upgrade because this self-managed Compose
bundle has no built-in backup scheduler or resource enforcement.

## Health and ingestion checks

After an operator-controlled deployment, run
`scripts/deploy/validate-langfuse.sh` on the Bazzite host. It requires HTTP
success and `status: OK` from `/api/public/health`. Also check
`podman compose --project-name cezar-factory --env-file integrations/bazzite/.env -f integrations/bazzite/compose.yaml ps`
for healthy Postgres, ClickHouse, Redis, and MinIO services. Submit one synthetic
OTLP trace with the project keys to the v4 `/api/public/otel/v1/traces` endpoint
and verify it appears in Langfuse. A 200 health response alone does not prove
that credentials, ingestion, or trace correlation work.

Never place prompt text, source code, environment values, API keys, or raw
provider payloads in telemetry. Cezar emits bounded workflow spans with
allowlisted identifiers and status fields; lifecycle outbox events are also
coarse. Keep trace links correlated by issue/run IDs. Use synthetic values for
smoke checks, then verify one real run and inspect it for secrets before
enabling wider retention.

## Backup and restore rehearsal

The built-in Compose example does not create backups. Before changing image
versions, rehearse against an isolated project and distinct ports, never the
production project. Use the same Langfuse release and a separate `.env` with
distinct passwords and project keys. Set `COMPOSE_PROJECT_NAME=langfuse-scratch`,
`LANGFUSE_WEB_PORT=3302`, `LANGFUSE_MINIO_API_PORT=9390`, and
`LANGFUSE_MINIO_CONSOLE_PORT=9391`; set `LANGFUSE_NEXTAUTH_URL` to
`http://localhost:3302` and the media endpoint to `http://localhost:9390`.
Choose unique organization/project/user IDs. Confirm the rendered Compose
configuration names only scratch volumes before starting it.

For a consistent backup, stop ingestion and the web/worker services, then save:

1. a PostgreSQL logical dump (`pg_dump --format=custom`),
2. a ClickHouse backup or stopped-volume snapshot, and
3. the MinIO `langfuse` bucket contents, including event and media objects.

Record the exact image tags and secret version references with the backup.
Redis can be recreated after restore only while ingestion is stopped and
queues are known to be drained; otherwise preserve its volume too. Restore all
stores into the isolated project, start dependencies first, then web and worker,
and verify health plus a known synthetic trace before considering the backup
usable. Do not assume a successful database dump alone is a complete restore.

For upgrades, take and verify that backup first, change only the scratch
Langfuse image tag, start the stack, and inspect migration logs, health,
synthetic OTLP ingestion, media access, and the UI. Keep the prior image tag and
backup available for rollback. Only document upgrade/restore as exercised after
recording date, image tags, result, and evidence; this repository change does
not claim a live Bazzite rehearsal.

## Evaluation fixture

[`integrations/langfuse/fixtures/factory-eval-fixture.json`](../integrations/langfuse/fixtures/factory-eval-fixture.json)
contains a deterministic two-host synthetic trace with linked agent and
verification observations. Use it to validate trace correlation and field
availability when wiring #137. It has no real prompts or secrets; it does not
score model quality or imply that production traces may be used as evaluation
data.

For the Cezar run explorer, use `createLangfuseTraceUrl` from
`cezar/packages/cezar/src/observability/trace-context.ts` with
`LANGFUSE_UI_URL`, the Langfuse project ID, and the 32-hex trace ID. The
helper preserves a configured base path and rejects invalid IDs, non-HTTP(S)
URLs, and embedded URL credentials. Never turn a project key into a public
share link; the ordinary trace URL still requires project access. The path
follows Langfuse's documented [trace URL format](https://langfuse.com/docs/observability/features/url).
