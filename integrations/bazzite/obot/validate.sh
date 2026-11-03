#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OBOT_ENV_FILE:-$SCRIPT_DIR/.env}"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
PROJECT="cezar-factory-obot-poc"
[[ -f "$ENV_FILE" ]] || { echo "Obot validation blocked: missing $ENV_FILE" >&2; exit 1; }
[[ "$(stat -c '%a' "$ENV_FILE")" == "600" ]] || { echo "Obot validation blocked: $ENV_FILE must be mode 0600" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck disable=SC1091
source "$FACTORY_ROOT/config/server-topology.env"
ip -o -4 addr show | awk '{split($4, item, "/"); print item[1]}' | grep -Fxq "${FACTORY_CONTROL_PLANE_ADDRESS:?topology lacks control-plane address}" || {
  echo "Obot validation blocked: this host does not own the control-plane address" >&2
  exit 1
}
podman_bin=(podman)
container="cezar-factory-obot-poc"
proxy_container="cezar-factory-obot-poc-https"
runtime_socket="/run/obot-runtime-api/podman.sock"
runtime_url="unix://$runtime_socket"

systemctl is-active --quiet cezar-factory-obot-runtime.socket || { echo "Obot validation failed: dedicated rootless runtime socket unit is inactive; run setup-runtime.sh" >&2; exit 1; }
[[ -S "$runtime_socket" ]] || { echo "Obot validation failed: dedicated rootless runtime socket is missing" >&2; exit 1; }
[[ "$(stat -c '%U:%G %a' "$runtime_socket")" == "$(id -un):$(id -gn) 660" ]] || { echo "Obot validation failed: runtime API socket permissions are broader or owned by another operator" >&2; exit 1; }
runtime_rootless="$("${podman_bin[@]}" --remote --url "$runtime_url" info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)"
runtime_graphroot="$("${podman_bin[@]}" --remote --url "$runtime_url" info --format '{{.Store.GraphRoot}}' 2>/dev/null || true)"
[[ "$runtime_rootless" == true && -n "$runtime_graphroot" ]] || { echo "Obot validation failed: isolated rootless Podman API is unavailable" >&2; exit 1; }

state="$("${podman_bin[@]}" inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
[[ "$state" == running ]] || { echo "Obot validation failed: container state is ${state:-missing}; inspect local logs after removing sensitive payloads." >&2; exit 1; }
proxy_state="$("${podman_bin[@]}" inspect --format '{{.State.Status}}' "$proxy_container" 2>/dev/null || true)"
[[ "$proxy_state" == running ]] || { echo "Obot validation failed: HTTPS proxy state is ${proxy_state:-missing}; inspect local logs after removing sensitive payloads." >&2; exit 1; }

host_port="${OBOT_HOST_PORT:-8787}"
code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "http://127.0.0.1:${host_port}/api/healthz" || true)"
[[ "$code" == 200 ]] || { echo "Obot validation failed: /api/healthz returned HTTP ${code:-000}; inspect local logs after removing sensitive payloads, then check hostname and listener." >&2; exit 1; }
proxy_volume="${OBOT_PROXY_DATA_VOLUME:-cezar-factory-obot-poc-proxy-data}"
proxy_volume_path="$("${podman_bin[@]}" volume inspect --format '{{.Mountpoint}}' "$proxy_volume")"
proxy_config_volume="${OBOT_PROXY_CONFIG_VOLUME:-cezar-factory-obot-poc-proxy-config}"
proxy_config_path="$("${podman_bin[@]}" volume inspect --format '{{.Mountpoint}}' "$proxy_config_volume")"
proxy_ca="$proxy_volume_path/caddy/pki/authorities/local/root.crt"
for _ in $(seq 1 60); do [[ -s "$proxy_ca" ]] && break; sleep 1; done
[[ -s "$proxy_ca" ]] || { echo "Obot validation failed: Caddy internal CA certificate did not appear in persistent proxy storage." >&2; exit 1; }
public_code="$(curl --silent --show-error --cacert "$proxy_ca" --output /dev/null --write-out '%{http_code}' --max-time 15 "${OBOT_PUBLIC_URL:?set OBOT_PUBLIC_URL to the trusted HTTPS LAN URL}/api/healthz" || true)"
[[ "$public_code" == 200 ]] || { echo "Obot validation failed: trusted HTTPS URL returned HTTP ${public_code:-000}; check LAN DNS, client trust of the Caddy CA, and reverse-proxy forwarding." >&2; exit 1; }

volume="${OBOT_DATA_VOLUME:-cezar-factory-obot-poc-data}"
volume_path="$("${podman_bin[@]}" volume inspect --format '{{.Mountpoint}}' "$volume")"
volume_mount="$(findmnt -n -o TARGET -T "$volume_path")"
expected_mount="$(realpath "${OBOT_REQUIRED_PODMAN_STORAGE_MOUNT:-/var/mnt/podman}")"
graphroot="$("${podman_bin[@]}" info --format '{{.Store.GraphRoot}}')"
graphroot_real="$(realpath "$graphroot")"
[[ "$graphroot_real" == "$expected_mount"/* && "$(findmnt -n -o TARGET -T "$graphroot")" == "$expected_mount" ]] || {
  echo "Obot validation failed: Podman graphroot is not on required secondary storage ($graphroot)" >&2
  exit 1
}
runtime_graphroot_real="$(realpath "$runtime_graphroot")"
runtime_root="$(realpath /var/mnt/podman/obot-runtime)"
[[ "$runtime_graphroot_real" == "$runtime_root"/* && "$(findmnt -n -o TARGET -T "$runtime_graphroot")" == "$expected_mount" && "$runtime_graphroot_real" != "$graphroot_real" ]] || {
  echo "Obot validation failed: isolated MCP runtime graphroot is not separate on secondary storage ($runtime_graphroot)" >&2
  exit 1
}
[[ "$(realpath "$volume_path")" == "$(realpath "${OBOT_REQUIRED_PODMAN_STORAGE_MOUNT:-/var/mnt/podman}")"/* && "$volume_mount" == "$expected_mount" ]] || {
  echo "Obot validation failed: data volume is not on required secondary storage ($volume_path on $volume_mount)" >&2
  exit 1
}
proxy_volume_mount="$(findmnt -n -o TARGET -T "$proxy_volume_path")"
[[ "$(realpath "$proxy_volume_path")" == "$expected_mount"/* && "$proxy_volume_mount" == "$expected_mount" ]] || {
  echo "Obot validation failed: HTTPS proxy data volume is not on required secondary storage ($proxy_volume_path on $proxy_volume_mount)" >&2
  exit 1
}
proxy_config_mount="$(findmnt -n -o TARGET -T "$proxy_config_path")"
[[ "$(realpath "$proxy_config_path")" == "$expected_mount"/* && "$proxy_config_mount" == "$expected_mount" ]] || {
  echo "Obot validation failed: HTTPS proxy config volume is not on required secondary storage ($proxy_config_path on $proxy_config_mount)" >&2
  exit 1
}

runtime_mount="$("${podman_bin[@]}" inspect --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}{{.Source}}:rw={{.RW}}{{end}}{{end}}' "$container")"
[[ "$runtime_mount" == "$runtime_socket:rw=true" ]] || { echo "Obot validation failed: Obot is not using the dedicated runtime socket with the required API connection access ($runtime_mount)" >&2; exit 1; }
security_options="$("${podman_bin[@]}" inspect --format '{{json .HostConfig.SecurityOpt}}' "$container")"
[[ "$security_options" == *'label=disable'* ]] || { echo "Obot validation failed: the app is not using the required Podman socket SELinux exception" >&2; exit 1; }
proxy_mounts="$("${podman_bin[@]}" inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$proxy_container")"
[[ "$proxy_mounts" != *"$runtime_socket"* && "$proxy_mounts" != *"/run/podman/podman.sock"* && "$proxy_mounts" != *"/var/run/docker.sock"* ]] || { echo "Obot validation failed: HTTPS proxy has a container-runtime socket mounted" >&2; exit 1; }
bound_ports="$("${podman_bin[@]}" inspect --format '{{json .HostConfig.PortBindings}}' "$container")"
[[ "$bound_ports" == *'127.0.0.1'* ]] || { echo "Obot validation failed: listener is not loopback-only ($bound_ports)" >&2; exit 1; }
proxy_listener="$(ss -H -ltn "sport = :${OBOT_HTTPS_PORT:-8443}")"
proxy_listener_address="$(printf '%s\n' "$proxy_listener" | awk 'NF {print $4}' | sort -u)"
[[ "$proxy_listener_address" == "${OBOT_BIND_ADDRESS:-}:${OBOT_HTTPS_PORT:-8443}" ]] || { echo "Obot validation failed: HTTPS listener address is ${proxy_listener_address:-missing}; expected ${OBOT_BIND_ADDRESS:-}:${OBOT_HTTPS_PORT:-8443}" >&2; exit 1; }

echo "Obot POC healthy (local HTTP $code; CA-verified HTTPS $public_code), app/proxy/runtime storage on secondary disk, HTTPS bound to ${OBOT_BIND_ADDRESS}:${OBOT_HTTPS_PORT}, app listener loopback-only, dedicated rootless runtime isolated from Factory Podman."
