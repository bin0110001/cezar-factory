# Cezar Factory deployment topology

## Server inventory

`config/server-topology.env` is the installation-specific source of truth for
host aliases, routable addresses, service placement, and the control-plane to
model-host network relationship. Copy `config/server-topology.env.example` and
edit it before deploying. It is ignored by Git; keep secrets in the existing
host-local `.env` files instead.

The deployment scripts reject a control-plane or vLLM deployment when the
corresponding service is not assigned to that host. They also derive the vLLM
upstream URL, proxy allowlist, remote-validation SSH destinations, health URL,
and Prometheus model target from this inventory. If the model host has more
than one address, put the address reachable from the control-plane in the
`FACTORY_VLLM_*` fields.

The supported home deployment separates control-plane services from local model
compute:

| Host | Services |
| --- | --- |
| Control-plane host | Cezar, OpenHands Agent Server/Canvas, Hindsight, LiteLLM gateway and PostgreSQL, Langfuse, Prometheus, Grafana, and supporting databases |
| Model host | vLLM model servers and model weights |

The control-plane host is the only deployment destination for Factory services.
The model host is used only as the trusted-network vLLM backend. No credentials are
stored in this repository. Use an environment file, Podman secrets, or the
host's secret manager.

The hosts are separate computers. Their addresses, SSH aliases, and Podman
connection names belong exclusively in `config/server-topology.env`.

## Network contract

- Control-plane services bind to localhost or the trusted LAN interface only.
- LiteLLM is the only model endpoint consumed by Cezar and Hindsight.
- LiteLLM forwards local inference to the model host's vLLM OpenAI-compatible API.
- vLLM is never exposed directly to the public Internet.
- Reverse proxy/TLS and firewall rules are host-owned deployment configuration.

The files in this directory are deployment templates and health-check guidance;
they do not contain production secrets or claim that a service is live.

## Deployment commands

From the Windows workstation, use the named Podman remote connection configured
for the control plane; do not use a local Podman VM. Copy
`integrations/bazzite/env.example` to
`integrations/bazzite/.env`, fill the host-local values, and run:

```bash
./scripts/deploy/deploy-control-plane.sh
./scripts/deploy/deploy-control-plane.sh --validate-only
```

The script uses the Podman connection and health base URL from topology. You
may override `PODMAN_CONNECTION` for a one-off operator workflow.

Cezar's multi-project controls require `CEZ_SINGLE_PROJECT` to be unset. When
set to `1`, the app hides **Settings → Projects**. Its checkout root
is `/projects` in the control-plane container and must be writable by the Cezar
process (UID/GID 10001 in the current deployment). The container home is not a
writable checkout location for that UID.

On the separate model host, create `integrations/mac-mini/vllm/.env` from
`env.example`, choose the model, and run:

```bash
./scripts/deploy/deploy-model-host.sh
./scripts/deploy/deploy-model-host.sh --validate-only
```

Run `scripts/deploy/validate-remote.sh` from an operator workstation to
validate both deployments over SSH. It reads the SSH destinations and model-host
checkout path from topology; its control-plane portion uses the named Podman
connection and streams only host-local OpenHands checks over SSH.
