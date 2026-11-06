#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${OBOT_ENV_FILE:-$SCRIPT_DIR/.env}"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
PROJECT="cezar-factory-obot-poc"
RUNTIME_API_SOCKET="/run/obot-runtime-api/podman.sock"
RUNTIME_API_URL="unix://$RUNTIME_API_SOCKET"
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

systemctl is-active --quiet cezar-factory-obot-runtime.socket || { echo "Obot teardown blocked: isolated runtime socket is inactive; start it before cleanup" >&2; exit 1; }
"${podman_bin[@]}" --remote --url "$RUNTIME_API_URL" info >/dev/null || { echo "Obot teardown blocked: isolated runtime API is unavailable" >&2; exit 1; }
"${podman_bin[@]}" stop cezar-factory-obot-poc >/dev/null 2>&1 || true
mapfile -t mcp_containers < <("${podman_bin[@]}" --remote --url "$RUNTIME_API_URL" ps --all --filter label=mcp.server.id --quiet)
if [[ "${#mcp_containers[@]}" -gt 0 ]]; then
  "${podman_bin[@]}" --remote --url "$RUNTIME_API_URL" rm --force "${mcp_containers[@]}"
fi
mapfile -t mcp_volumes < <("${podman_bin[@]}" --remote --url "$RUNTIME_API_URL" volume ls --filter label=mcp.server.id --quiet)
if [[ "${#mcp_volumes[@]}" -gt 0 ]]; then
  "${podman_bin[@]}" --remote --url "$RUNTIME_API_URL" volume rm "${mcp_volumes[@]}"
fi
"${podman_bin[@]}" compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down
echo "Obot POC containers and labeled MCP workloads removed. Persistent data volume '${OBOT_DATA_VOLUME:-cezar-factory-obot-poc-data}' and isolated runtime account were preserved."
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
