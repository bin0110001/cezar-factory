#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy and validate the Factory control-plane stack selected by server topology.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT_DIR/scripts/deploy/lib-topology.sh"
load_factory_topology "$ROOT_DIR"
STACK_DIR="${ROOT_DIR}/integrations/bazzite"
ENV_FILE="${STACK_DIR}/.env"
VALIDATE_ONLY=0
DOWN=0
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cezar-factory}"
PODMAN_CONNECTION="${PODMAN_CONNECTION:-$FACTORY_CONTROL_PLANE_PODMAN_CONNECTION}"

usage() {
  cat <<'EOF'
Usage: deploy-bazzite.sh [--validate-only] [--down]

Requires integrations/bazzite/.env copied from env.example on the Bazzite host.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --validate-only) VALIDATE_ONLY=1 ;;
    --down) DOWN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

command -v podman >/dev/null || { echo "podman is required" >&2; exit 1; }
for service in cezar openhands hindsight litellm langfuse prometheus grafana vault; do
  topology_host_runs "$FACTORY_CONTROL_PLANE_SERVICES" "$service" || {
    echo "topology assigns $service away from $FACTORY_CONTROL_PLANE_ID; this control-plane bundle cannot deploy it" >&2
    exit 1
  }
done
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE; copy env.example and fill host secrets" >&2; exit 1; }
required_vars=(CEZAR_IMAGE OPENHANDS_IMAGE HINDSIGHT_IMAGE LITELLM_IMAGE LITELLM_DB_IMAGE LANGFUSE_IMAGE PROMETHEUS_IMAGE GRAFANA_IMAGE NODE_EXPORTER_IMAGE CADVISOR_IMAGE VAULT_IMAGE HINDSIGHT_FACTORY_BANK HINDSIGHT_PROJECT_BANK LITELLM_MASTER_KEY LITELLM_SALT_KEY LITELLM_DB_NAME LITELLM_DB_USER LITELLM_DB_PASSWORD LITELLM_DATABASE_URL OPENHANDS_SESSION_API_KEY FACTORY_RUNTIME_HOST_DIR)
for name in "${required_vars[@]}"; do
  value="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  [[ -n "$value" ]] || { echo "missing required $name in $ENV_FILE" >&2; exit 1; }
done
FACTORY_RUNTIME_HOST_DIR_VALUE="$(grep -E '^FACTORY_RUNTIME_HOST_DIR=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
# Cezar runs these workflows inside Linux and receives this host checkout at
# /projects/cezar-factory. Validate the startup path as well as the scheduled
# audit path so a stale or partial checkout cannot deploy successfully and
# fail later when a workflow starts.
required_runtime_files=(
  scripts/factory-startup.ps1
  scripts/select-intake-issue.ps1
  scripts/classify-intake.ps1
  scripts/validate-intake-or-no-work.ps1
  scripts/route-intake-or-no-work.ps1
  scripts/audit-backlog-labels.ps1
  scripts/maintain-repository.ps1
)
for runtime_file in "${required_runtime_files[@]}"; do
  [[ -f "$FACTORY_RUNTIME_HOST_DIR_VALUE/$runtime_file" ]] || {
    echo "Factory runtime is missing $FACTORY_RUNTIME_HOST_DIR_VALUE/$runtime_file" >&2
    exit 1
  }
done
if grep -Eq '(change-me-on-host|REPLACE_ON_BAZZITE|REPLACE_WITH_|project-REPLACE_|registry\.example)' "$ENV_FILE"; then
  echo "replace all deployment secret/model placeholders in $ENV_FILE" >&2
  exit 1
fi

# Prometheus does not interpolate environment variables in its YAML. Render the
# one cross-host target from inventory before Compose mounts the configuration.
MODEL_TARGET_FILE="$STACK_DIR/prometheus-model-targets.generated.json"
printf '[\n  {"targets": ["%s"], "labels": {"role": "model-host"}}\n]\n' \
  "$FACTORY_VLLM_METRICS_TARGET" > "$MODEL_TARGET_FILE"

VLLM_BASE_URL="$FACTORY_VLLM_BASE_URL"
NO_PROXY="${NO_PROXY:-${FACTORY_VLLM_METRICS_TARGET%%:*},127.0.0.1,localhost}"
export VLLM_BASE_URL NO_PROXY

compose=(podman --connection "$PODMAN_CONNECTION" compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$STACK_DIR/compose.yaml")
"${compose[@]}" config >/dev/null

if (( DOWN )); then
  "${compose[@]}" down
  exit 0
fi

if (( ! VALIDATE_ONLY )); then
  "${compose[@]}" up -d
fi

BAZZITE_HEALTH_BASE_URL="${BAZZITE_HEALTH_BASE_URL:-${FACTORY_CONTROL_PLANE_HEALTH_BASE_URL:-http://127.0.0.1}}"
"$ROOT_DIR/scripts/deploy/validate-deployment.sh" control-plane "$BAZZITE_HEALTH_BASE_URL"
