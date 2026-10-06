#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy and validate the Factory control-plane stack on the Bazzite server.
# vLLM is deliberately excluded; deploy it with deploy-vllm-mac.sh on the Mac mini.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_DIR="${ROOT_DIR}/integrations/bazzite"
ENV_FILE="${STACK_DIR}/.env"
VALIDATE_ONLY=0
DOWN=0
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cezar-factory}"
PODMAN_CONNECTION="${PODMAN_CONNECTION:-bazzite}"

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
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE; copy env.example and fill host secrets" >&2; exit 1; }
required_vars=(CEZAR_IMAGE OPENHANDS_IMAGE HINDSIGHT_IMAGE LITELLM_IMAGE LITELLM_DB_IMAGE LANGFUSE_IMAGE PROMETHEUS_IMAGE GRAFANA_IMAGE NODE_EXPORTER_IMAGE CADVISOR_IMAGE HINDSIGHT_FACTORY_BANK HINDSIGHT_PROJECT_BANK LITELLM_MASTER_KEY LITELLM_SALT_KEY LITELLM_DB_NAME LITELLM_DB_USER LITELLM_DB_PASSWORD LITELLM_DATABASE_URL OPENHANDS_SESSION_API_KEY VLLM_BASE_URL)
for name in "${required_vars[@]}"; do
  value="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  [[ -n "$value" ]] || { echo "missing required $name in $ENV_FILE" >&2; exit 1; }
done
if grep -Eq '(change-me-on-host|REPLACE_ON_BAZZITE|REPLACE_WITH_|project-REPLACE_|registry\.example)' "$ENV_FILE"; then
  echo "replace all deployment secret/model placeholders in $ENV_FILE" >&2
  exit 1
fi

compose=(podman --connection "$PODMAN_CONNECTION" compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$STACK_DIR/compose.yaml")
"${compose[@]}" config >/dev/null

if (( DOWN )); then
  "${compose[@]}" down
  exit 0
fi

if (( ! VALIDATE_ONLY )); then
  "${compose[@]}" up -d
fi

BAZZITE_HEALTH_BASE_URL="${BAZZITE_HEALTH_BASE_URL:-http://127.0.0.1}"
"$ROOT_DIR/scripts/deploy/validate-deployment.sh" bazzite "$BAZZITE_HEALTH_BASE_URL"
