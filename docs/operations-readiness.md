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

Evidence: `podman compose ps`, all health URLs passing, the Cezar health check,
the read-only Factory runtime mount at `/projects/cezar-factory`, the expected
`FACTORY_RUNTIME_ROOT`, matching host/container Factory version and content
digest, Prometheus targets up, Grafana dashboard loading, LiteLLM PostgreSQL
healthy, and LiteLLM successfully reaching Mac mini vLLM. LiteLLM must also
return HTTP 200 for authenticated `/health`, `/v1/models`, and the Admin UI
route. Use the supported Bazzite deployment and parity checks; do not edit the
host checkout by hand.

## 3. Cezar runner and workflow readiness

Factory automations execute through Cezar. `routing/automation-catalog.json`
defines source-configured runner/model profiles: Claude Sonnet for planning
and independent review; the configured Factory gateway for investigation,
fix-review, maintenance, and small implementation; GPT-5.6 Luna for medium
implementation; and GPT-6.1 Sol for large implementation. Script-only
workflows, including intake and failure-audit collection, do not invoke an
agent merely because their automation metadata has a runner/model value.

For each explicitly configured pilot project, verify which automations are
enabled, that the selected runner can authenticate, and that a bounded run
produces the expected workflow and validation receipts. Record the run ID,
workflow, selected runner/model, terminal outcome, validation evidence, and any
recovery. Source profiles do not prove live enablement, authentication,
capacity, or successful execution. If no target is configured, leave these
runtime checks open; do not discover a project or enable automations as a
substitute.

## 4. Memory and observability

Create the Factory and project Hindsight banks, validate the MCP endpoint with
authentication, and demonstrate one bounded recall before planning and one
durable retain after investigation. Confirm Langfuse receives the project,
workflow, issue, runner, provider, and model metadata from Cezar executions.
Confirm Grafana and Prometheus alert when the Mac mini endpoint is unavailable.

## 5. Final acceptance

Run `scripts/deploy/validate-remote.sh` from the supported operator environment
with its documented host targets, attach the output to the corresponding
workplan evidence row, and run the Factory self-test. Mark a live checklist
item complete only when its named runtime evidence exists; source configuration
and historical snapshots do not satisfy live acceptance.
