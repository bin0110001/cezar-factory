# Bazzite deployment

Bazzite is the deployment target for all Factory services except vLLM. Run the
service stack with Podman Compose (or translate the template to Quadlet) after
filling the environment values in `env.example`.

The selected control-plane host and its named Podman connection are configured
in `config/server-topology.env`; do not use a model-host connection or the
local Podman VM for this stack.

Required services:

- Cezar control plane;
- OpenHands Agent Server/Canvas;
- Hindsight memory;
- LiteLLM gateway;
- dedicated PostgreSQL database for LiteLLM;
- Langfuse observability;
- Prometheus and Grafana infrastructure monitoring.
- HashiCorp Vault for Factory and project secrets.

OpenHands Canvas is loopback-bound by default at Bazzite port 3001. For
temporary trusted-LAN configuration access, set the host-local
`OPENHANDS_BIND_ADDRESS=0.0.0.0`, redeploy the OpenHands service, and restore
`127.0.0.1` afterward. Do not expose the Agent Server or other control-plane
ports directly.

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

## Cezar OpenCode runner

The locally built Cezar image includes OpenCode. To configure its persistent
profile for the Bazzite LiteLLM gateway, run
`scripts/deploy/configure-cezar-opencode.sh` from the Bazzite checkout. The
script reads LiteLLM's master key from the running gateway container into a
Podman secret, mounts that secret into Cezar, and configures OpenCode to use
`factory-code` (with `factory-small` also available). OpenCode config and state
are stored in the existing Cezar OpenCode volumes; the key is not written to
the repository or systemd unit.
