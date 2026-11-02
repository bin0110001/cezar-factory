#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${OBOT_ENV_FILE:-$SCRIPT_DIR/.env}"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
PROJECT="cezar-factory-obot-poc"

fail() { echo "Obot deployment blocked: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || fail "missing $ENV_FILE; copy env.example and set host-local values"
[[ -f "$COMPOSE_FILE" ]] || fail "missing $COMPOSE_FILE"
[[ -f "$SCRIPT_DIR/Caddyfile" ]] || fail "missing Caddyfile"
[[ -f "$FACTORY_ROOT/config/server-topology.env" ]] || fail "missing Factory host topology inventory"
[[ "$(stat -c '%a' "$ENV_FILE")" == "600" ]] || fail "$ENV_FILE must be mode 0600 because it contains bootstrap credentials"

# shellcheck disable=SC1090
source "$FACTORY_ROOT/config/server-topology.env"
# shellcheck disable=SC1090
source "$ENV_FILE"

[[ " ${FACTORY_CONTROL_PLANE_SERVICES:-} " == *" obot "* && " ${FACTORY_CONTROL_PLANE_SERVICES:-} " == *" obot-https "* ]] || fail "add obot and obot-https to FACTORY_CONTROL_PLANE_SERVICES in the host topology inventory"
[[ "${FACTORY_CONTROL_PLANE_ADDRESS:-}" != "" ]] || fail "topology is missing FACTORY_CONTROL_PLANE_ADDRESS"
ip -o -4 addr show | awk '{split($4, item, "/"); print item[1]}' | grep -Fxq "$FACTORY_CONTROL_PLANE_ADDRESS" || fail "this host does not own FACTORY_CONTROL_PLANE_ADDRESS=$FACTORY_CONTROL_PLANE_ADDRESS"
[[ "${OBOT_IMAGE:-}" =~ ^ghcr\.io/obot-platform/obot:v[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]{64}$ ]] || fail "OBOT_IMAGE must pin a version and immutable sha256 digest"
[[ "${CADDY_IMAGE:-}" =~ ^docker\.io/library/caddy:[0-9]+\.[0-9]+\.[0-9]+-alpine@sha256:[a-f0-9]{64}$ ]] || fail "CADDY_IMAGE must pin a version and immutable sha256 digest"
[[ "${OBOT_BOOTSTRAP_TOKEN:-}" != "" && "${OBOT_BOOTSTRAP_TOKEN:-}" != "REPLACE_ON_BAZZITE" ]] || fail "set a host-local OBOT_BOOTSTRAP_TOKEN"
[[ "${OBOT_BIND_ADDRESS:-}" == "$FACTORY_CONTROL_PLANE_ADDRESS" ]] || fail "OBOT_BIND_ADDRESS must equal the configured Bazzite LAN address"
[[ "${OBOT_TLS_HOSTNAME:-}" =~ ^obot\.[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.sslip\.io$ ]] || fail "OBOT_TLS_HOSTNAME must use the configured LAN address under sslip.io"
resolved_addresses="$(getent ahostsv4 "$OBOT_TLS_HOSTNAME" | awk '{print $1}' | sort -u || true)"
[[ "$resolved_addresses" == "$FACTORY_CONTROL_PLANE_ADDRESS" ]] || fail "OBOT_TLS_HOSTNAME must resolve only to $FACTORY_CONTROL_PLANE_ADDRESS (got ${resolved_addresses:-no IPv4 answer})"
[[ "${OBOT_HTTPS_PORT:-}" =~ ^[0-9]+$ && "$OBOT_HTTPS_PORT" -ge 1024 && "$OBOT_HTTPS_PORT" -le 65535 ]] || fail "OBOT_HTTPS_PORT must be an unprivileged TCP port"
[[ "${OBOT_SERVER_HOSTNAME:-}" == "$OBOT_TLS_HOSTNAME:$OBOT_HTTPS_PORT" ]] || fail "OBOT_SERVER_HOSTNAME must include the TLS hostname and HTTPS port"
[[ "${OBOT_PUBLIC_URL:-}" == "https://$OBOT_SERVER_HOSTNAME" ]] || fail "OBOT_PUBLIC_URL must be the exact HTTPS Obot URL with no path"
[[ "${OBOT_HOST_PORT:-}" =~ ^[0-9]+$ && "$OBOT_HOST_PORT" -ge 1024 && "$OBOT_HOST_PORT" -le 65535 ]] || fail "OBOT_HOST_PORT must be an unprivileged TCP port"
[[ "${OBOT_PROXY_DATA_VOLUME:-}" != "" && "${OBOT_PROXY_CONFIG_VOLUME:-}" != "" ]] || fail "set persistent Caddy data and config volume names"
proxy_state="$(podman inspect --format '{{.State.Status}}' cezar-factory-obot-poc-https 2>/dev/null || true)"
if [[ "$proxy_state" != running ]]; then
  [[ -z "$(ss -H -ltn "sport = :$OBOT_HTTPS_PORT")" ]] || fail "TCP port $OBOT_HTTPS_PORT is already listening"
fi
obot_state="$(podman inspect --format '{{.State.Status}}' cezar-factory-obot-poc 2>/dev/null || true)"
if [[ "$obot_state" != running ]]; then
  [[ -z "$(ss -H -ltn "sport = :$OBOT_HOST_PORT")" ]] || fail "TCP port $OBOT_HOST_PORT is already listening"
fi

podman_bin=(podman)
graphroot="$("${podman_bin[@]}" info --format '{{.Store.GraphRoot}}')"
storage_mount="${OBOT_REQUIRED_PODMAN_STORAGE_MOUNT:-/var/mnt/podman}"
[[ -d "$storage_mount" ]] || fail "required secondary storage mount is unavailable: $storage_mount"
graphroot_real="$(realpath "$graphroot")"
mount_real="$(realpath "$storage_mount")"
[[ "$graphroot_real" == "$mount_real"/* ]] || fail "Podman graphroot $graphroot is not on required storage mount $storage_mount"
actual_mount="$(findmnt -n -o TARGET -T "$graphroot")"
[[ "$actual_mount" == "$mount_real" ]] || fail "Podman graphroot resolves to mount $actual_mount, expected $mount_real"

export OBOT_IMAGE CADDY_IMAGE OBOT_BIND_ADDRESS OBOT_TLS_HOSTNAME OBOT_HTTPS_PORT OBOT_SERVER_HOSTNAME OBOT_HOST_PORT OBOT_BOOTSTRAP_TOKEN OBOT_DATA_VOLUME OBOT_PROXY_DATA_VOLUME OBOT_PROXY_CONFIG_VOLUME
"${podman_bin[@]}" compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet
"${podman_bin[@]}" compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

"$SCRIPT_DIR/validate.sh"
echo "Obot POC deployed on $graphroot (secondary mount $actual_mount); no Podman socket is mounted."
