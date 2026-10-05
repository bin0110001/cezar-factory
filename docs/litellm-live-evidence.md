# LiteLLM live deployment evidence

Captured 2026-10-04 after migrating the gateway on the Bazzite host.

- Container: `cezar-factory-litellm`
- Image: `ghcr.io/berriai/litellm:main-stable`
- Listener: Bazzite host network, port `4001`
- Config: `/var/home/bin0110001/cezar-factory-litellm-config.yaml`
- Database: dedicated PostgreSQL container `cezar-factory-litellm-db`, persistent
  volume `cezar-factory-litellm-db-data`, bound to localhost only
- Upstream: Mac mini vLLM at `http://192.168.86.60:8000/v1`
- Private-network proxy bypass: `NO_PROXY=192.168.86.60,127.0.0.1,localhost`

## Live checks

All checks were run from the Bazzite host with the gateway API key kept local and omitted from output.

- Authenticated `GET /health`: HTTP 200; two healthy upstream deployments and zero unhealthy deployments.
- Authenticated `GET /v1/models`: returned `factory-small` and `factory-code`.
- Authenticated bounded `POST /v1/chat/completions` for `factory-code`: HTTP 200, routed through to the vLLM model `qwen3.5-9b`.
- Authenticated Admin UI route: HTTP 200.
- PostgreSQL health: healthy; LiteLLM container remained `Up` after the checks.

The database uses a dedicated localhost port on this host because port 5432 was
already occupied by an unrelated PostgreSQL service. The checked-in Compose
deployment uses the internal `litellm-db:5432` service name instead.

The gateway deployment is intentionally separate from Cezar because the Cezar runtime is not yet present on Bazzite. Utility-workflow connection remains an open plan item.
