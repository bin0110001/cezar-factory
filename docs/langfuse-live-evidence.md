# Langfuse live deployment evidence

Captured 2026-10-03 on Bazzite using the official Langfuse v4 self-hosted Compose stack.

- Project: `cezar-langfuse`
- Web endpoint: localhost port 3002
- Stack: Langfuse web and worker, PostgreSQL, ClickHouse, Redis, and MinIO
- Langfuse version: `4.50.0`
- LiteLLM callback: `langfuse_otel`
- OTEL host: the localhost Langfuse web service
- Host ports were remapped to avoid existing services; internal Compose service URLs remain unchanged.

## Live checks

- `GET /api/public/health`: HTTP 200, status `OK`, version `4.50.0`.
- A bounded `factory-small` completion through LiteLLM: HTTP 200.
- Langfuse v4 Observations API: HTTP 200 and returned a `GENERATION` observation named `litellm_request` for project `cezar-factory`, with a nested `SPAN` for the raw provider request.
- All six Langfuse stack containers were running; Postgres, ClickHouse, Redis, and MinIO reported healthy.

Langfuse v4 `events_only` mode rejects the legacy LiteLLM `langfuse` callback, so the deployment uses the official `langfuse_otel` integration and v2 Observations API.
