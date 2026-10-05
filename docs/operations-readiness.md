# Operations readiness runbook

This document is the evidence checklist for the remaining live workplan items.
It intentionally does not mark a runtime item complete until its command output
or service artifact is attached to the project record.

## 1. Mac mini vLLM

On the Mac mini:

```bash
cp integrations/mac-mini/vllm/env.example integrations/mac-mini/vllm/.env
# edit .env: choose general/coding model and API key
./scripts/deploy/deploy-vllm-mac.sh
./scripts/deploy/deploy-vllm-mac.sh --validate-only
```

Evidence: `/health`, `/v1/models`, a successful authenticated completion, and
three recorded runs for latency, throughput, and peak memory. Record the model
ID, runtime flags, GPU topology, and compatibility notes.

## 2. Bazzite services (192.168.86.69)

From Windows, target the separate Bazzite Podman engine through the named
`bazzite` remote connection. Do not run this against the Mac mini or the local
Podman VM:

```bash
cp integrations/bazzite/env.example integrations/bazzite/.env
# edit .env with pinned image digests, trusted endpoints, and secrets
./scripts/deploy/deploy-bazzite.sh
./scripts/deploy/deploy-bazzite.sh --validate-only
```

Evidence: `podman compose ps`, all health URLs passing, the OpenHands project
workspace validator passing with a clean `HEAD`, Prometheus targets up, Grafana
dashboard loading, LiteLLM PostgreSQL healthy, and LiteLLM successfully reaching
Mac mini vLLM. LiteLLM must also return HTTP 200 for authenticated `/health`,
`/v1/models`, and the Admin UI route.

The deployment validator also reports ACP readiness without printing secrets.
The current live result is `codex-acp,claude-agent-acp` installed with the
active `default:openhands` profile; an authenticated ACP profile is therefore
still an explicit operator prerequisite for premium execution.

## 3. OpenHands proof of concept

Create one low-risk issue and run it through the Agent Server with Codex, then
repeat with Claude. Capture the provider request/result JSON, branch, PR URL,
worktree identifiers, validation output, and recovery behavior. Run both jobs
at once to prove isolation and concurrency. Cezar should only retain the
compact execution record.

## 4. Memory and observability

Create the Factory and project Hindsight banks, validate the MCP endpoint with
authentication, and demonstrate one bounded recall before planning and one
durable retain after investigation. Confirm Langfuse receives the project,
workflow, issue, worker, provider, and model metadata. Confirm Grafana and
Prometheus alert when the Mac mini endpoint is unavailable.

## 5. Final acceptance

Run `scripts/deploy/validate-remote.sh`, attach its output, run the Factory
self-test, and only then mark the corresponding live checklist entries and
success criteria in `cezar_factory_workplan.md`.
