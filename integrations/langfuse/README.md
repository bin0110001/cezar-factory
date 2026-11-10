# Langfuse integration contract

Langfuse runs on Bazzite using the official self-hosted Compose architecture:
web and worker, PostgreSQL, ClickHouse, Redis, and MinIO. The Compose bundle is
single-node and does not provide built-in backup orchestration. Deployment
versions, host ports, secrets, sizing, health, backup/restore, and scratch
upgrade procedures are documented in [`docs/langfuse-operations.md`](../../docs/langfuse-operations.md).
LiteLLM is the first instrumentation boundary for local-model traffic. For
Langfuse v4, use LiteLLM's `langfuse_otel` callback and query the v2 Observations
API; the legacy `langfuse` callback is incompatible with the default
`events_only` mode. The deployment health check is
`scripts/deploy/validate-langfuse.sh`.

Each request should carry these metadata fields when they are available:

- `project`;
- `workflow`;
- `github_issue`;
- `worker`;
- `provider`;
- `model`.

Subscription-agent token counts may be unavailable, so those executions record
coarse duration, attempts, changed-file count, and validation status instead.
Langfuse credentials remain host-local. The browser endpoint is loopback-bound
at port 3002; data services have no host-published ports. Lifecycle outbox
exports use `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY`.
Set a stable unique `CEZ_WORKER_ID` per Cezar host for multi-host correlation.
Prompt and source text are excluded; telemetry attributes are allowlisted and
coarse.
