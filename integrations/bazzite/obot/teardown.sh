#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${OBOT_ENV_FILE:-$SCRIPT_DIR/.env}"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
PROJECT="cezar-factory-obot-poc"
[[ -f "$ENV_FILE" ]] || { echo "Obot teardown blocked: missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$FACTORY_ROOT/config/server-topology.env"
# shellcheck disable=SC1090
source "$ENV_FILE"
podman_bin=(podman)

if ! ip -o -4 addr show | awk '{split($4, item, "/"); print item[1]}' | grep -Fxq "${FACTORY_CONTROL_PLANE_ADDRESS:?topology lacks control-plane address}"; then
  echo "Obot teardown blocked: this host does not own the configured control-plane address" >&2
  exit 1
fi

if [[ $# -gt 0 && "${1:-}" != "--purge-data" ]]; then
  echo "Usage: $0 [--purge-data]" >&2
  exit 2
fi

"${podman_bin[@]}" compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down
echo "Obot POC container and network removed. Persistent data volume '${OBOT_DATA_VOLUME:-cezar-factory-obot-poc-data}' was preserved."
if [[ "${1:-}" == "--purge-data" ]]; then
  volume="${OBOT_DATA_VOLUME:-cezar-factory-obot-poc-data}"
  proxy_data="${OBOT_PROXY_DATA_VOLUME:-cezar-factory-obot-poc-proxy-data}"
  proxy_config="${OBOT_PROXY_CONFIG_VOLUME:-cezar-factory-obot-poc-proxy-config}"
  confirmation_text="REMOVE $volume $proxy_data $proxy_config"
  read -r -p "Type '$confirmation_text' to permanently remove Obot and HTTPS CA data: " confirmation
  [[ "$confirmation" == "$confirmation_text" ]] || { echo "All data volumes preserved."; exit 1; }
  "${podman_bin[@]}" volume rm "$volume" "$proxy_data" "$proxy_config"
  echo "Obot POC data and HTTPS CA volumes removed."
fi
