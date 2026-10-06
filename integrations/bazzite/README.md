# Bazzite deployment

Bazzite is the deployment target for all Factory services except vLLM. Run the
service stack with Podman Compose (or translate the template to Quadlet) after
filling the environment values in `env.example`.

The selected control-plane host and its named Podman connection are configured
in `config/server-topology.env`; do not use a model-host connection or the
local Podman VM for this stack.

Required services:

- Cezar control plane;
- Hindsight memory;
- LiteLLM gateway;
- dedicated PostgreSQL database for LiteLLM;
- Langfuse observability;
- Prometheus and Grafana infrastructure monitoring.
- HashiCorp Vault for Factory and project secrets.

Factory automations execute directly in Cezar. OpenHands is not used by the
active deployment and is not required to run scheduled jobs. The retained
OpenHands Compose service and related validation scripts are legacy/reference
material; do not enable or troubleshoot them as part of the current Factory
runtime.

The template intentionally uses image variables because image tags and the
chosen persistence backends are deployment decisions. Pin concrete digests in
the Bazzite checkout before production use.

## Vault

Vault is loopback-only on Bazzite and uses persistent integrated Raft storage.
Deploy and bootstrap it separately with the instructions in
[`docs/vault.md`](../../docs/vault.md); the bootstrap token and recovery keys
must never be put in `.env` or committed.

LiteLLM uses the internal `litellm-db` PostgreSQL service and the persistent
`litellm-db-data` volume. Set `LITELLM_DATABASE_URL`,
`LITELLM_DB_PASSWORD`, and `LITELLM_SALT_KEY` in the host-local environment;
do not reuse the model-host API key for any of them. The database is not
published outside the Compose network.

Before enabling `worktree=true` jobs, validate the persistent project checkout
from the Bazzite host:

```bash
./scripts/deploy/validate-openhands-workspace.sh
```

The base workspace must contain a valid Git `HEAD` and be clean. This prevents
a job from failing during worktree creation because the persistent `/projects`
volume was mounted without a repository checkout. Add `--require-origin` when
the deployment is expected to use a configured remote.

## Legacy Cezar runner configuration

The former OpenCode runner configuration is retained only for migration
history. Current Factory automations do not use OpenCode or OpenHands; Cezar
executes the configured Codex, Claude, and Factory-gateway routes directly.
Do not run the legacy `configure-cezar-opencode.sh` helper for the active
deployment.
