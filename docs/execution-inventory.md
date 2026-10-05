# Factory execution inventory

This inventory records the owners and evidence sources for Factory components.
It is deliberately an index, not a second policy source; `routing/automation-catalog.json`, workflow YAML, and tests are normative for their respective contracts.

| Component | Owner | Contract/evidence |
| --- | --- | --- |
| Lifecycle labels and transitions | Factory scripts / Cezar | `scripts/route-state.ps1`, `tests/run-tests.ps1` |
| Workflow initiation and retries | Cezar | `workflows/*.yaml`, automation fixtures; workflows run isolated worktrees |
| Workflow runtime scripts, policies and schemas | Version-pinned Factory runtime | `$FACTORY_RUNTIME_ROOT`, `docs/synchronization.md` |
| Premium isolated sessions | OpenHands | `integrations/openhands/*`, `docs/openhands-live-evidence.md` |
| Local advisory jobs | LiteLLM + vLLM | `scripts/local/run-local-job.ps1`, `routing/local-jobs.yaml` |
| Automation selection | Factory catalog | `routing/automation-catalog.json`, `scripts/validate-automation-catalog.ps1` |
| Bounded recall and retention | Hindsight | `scripts/hindsight/*`, `integrations/hindsight/*` |
| Backlog selection and leases | Factory reconciler / GitHub | `scripts/reconcile-backlog.ps1`, `scripts/lease.ps1` |
| Telemetry | Langfuse, Prometheus, Grafana | `integrations/langfuse`, `integrations/bazzite/grafana` |

Hindsight is deployed and the NeonPath planning pilot consumed a bounded recall
artifact. Retention remains human-approved and has not been exercised.
