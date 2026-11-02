#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_USER="obot-runtime"
RUNTIME_HOME="/var/mnt/podman/obot-runtime/home"
RUNTIME_ROOT="/var/mnt/podman/obot-runtime"
RUNTIME_API_DIR="/run/obot-runtime-api"
RUNTIME_API_SOCKET="$RUNTIME_API_DIR/podman.sock"
SERVICE_NAME="cezar-factory-obot-runtime"
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME.service"
SOCKET_PATH="/etc/systemd/system/$SERVICE_NAME.socket"
TMPFILES_PATH="/etc/tmpfiles.d/$SERVICE_NAME.conf"

fail() { echo "Obot runtime setup blocked: $*" >&2; exit 1; }

[[ "$EUID" == 0 ]] || fail "run with sudo from the Bazzite Factory checkout"
[[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] || fail "run through sudo as the Bazzite operator user"
[[ "$SUDO_USER" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail "unexpected operator account name"
id "$SUDO_USER" >/dev/null 2>&1 || fail "operator account $SUDO_USER does not exist"
operator_group="$(id -gn "$SUDO_USER")"
[[ "$operator_group" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail "unexpected operator group name"
for command_name in podman useradd usermod runuser setfacl systemctl systemd-tmpfiles timeout; do
  command -v "$command_name" >/dev/null || fail "$command_name is required on Bazzite"
done
for target in "$SERVICE_PATH" "$SOCKET_PATH" "$TMPFILES_PATH"; do
  if [[ -e "$target" ]] && ! grep -Fq '# Managed by integrations/bazzite/obot/setup-runtime.sh' "$target"; then
    fail "$target already exists and is not managed by this setup script"
  fi
done
[[ -d /var/mnt/podman ]] || fail "secondary storage mount /var/mnt/podman is unavailable"
[[ "$(findmnt -n -o TARGET -T /var/mnt/podman)" == /var/mnt/podman ]] || fail "/var/mnt/podman is not a mounted secondary filesystem"
[[ -f /etc/subuid && -f /etc/subgid ]] || fail "rootless Podman subordinate-ID databases are unavailable"
operator_home="$(cut -d: -f6 < <(getent passwd "$SUDO_USER"))"
factory_graphroot="$(runuser -u "$SUDO_USER" -- env HOME="$operator_home" podman info --format '{{.Store.GraphRoot}}')"
factory_graphroot="$(realpath "$factory_graphroot")"
[[ "$factory_graphroot" == /var/mnt/podman/* ]] || fail "the existing Factory Podman graphroot is not on /var/mnt/podman ($factory_graphroot)"
[[ "$(findmnt -n -o TARGET -T "$factory_graphroot")" == /var/mnt/podman ]] || fail "the existing Factory Podman graphroot is not on the secondary filesystem"
factory_storage_parent="$(dirname "$factory_graphroot")"
[[ -d "$factory_storage_parent" && "$factory_storage_parent" != "$RUNTIME_ROOT"* ]] || fail "the existing Factory graphroot has an unexpected parent ($factory_storage_parent)"
[[ "$factory_storage_parent" =~ ^[A-Za-z0-9_./-]+$ ]] || fail "the Factory graphroot path contains unsupported systemd characters"
for owned_path in "$RUNTIME_ROOT" "$RUNTIME_HOME" "$RUNTIME_ROOT/storage" "$RUNTIME_ROOT/tmp"; do
  if [[ -e "$owned_path" && "$(stat -c '%U' "$owned_path")" != "$RUNTIME_USER" ]]; then
    fail "refusing to take ownership of pre-existing path $owned_path"
  fi
done

runtime_record="$(getent passwd "$RUNTIME_USER" || true)"
if [[ -z "$runtime_record" ]]; then
  useradd --system --create-home --home-dir "$RUNTIME_HOME" --shell /sbin/nologin --user-group "$RUNTIME_USER"
else
  existing_home="$(cut -d: -f6 <<< "$runtime_record")"
  [[ "$existing_home" == "$RUNTIME_HOME" ]] || fail "$RUNTIME_USER already exists with unexpected home $existing_home"
fi
ensure_subordinate_range() {
  local file="$1" option="$2" existing_start="" existing_count="" max_end start end
  read -r existing_start existing_count < <(awk -F: -v name="$RUNTIME_USER" '$1 == name { print $2, $3; exit }' "$file") || true
  if [[ -n "$existing_start" ]]; then
    (( existing_count >= 65536 )) || fail "$RUNTIME_USER has fewer than 65536 subordinate IDs in $file"
    if awk -F: -v name="$RUNTIME_USER" -v start="$existing_start" -v count="$existing_count" '$1 != name && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $2 < start + count && $2 + $3 > start { overlap = 1 } END { exit !overlap }' "$file"; then
      fail "$RUNTIME_USER subordinate-ID range overlaps another account in $file"
    fi
    return
  fi
  max_end="$(awk -F: 'NF == 3 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { end = $2 + $3; if (end > max) max = end } END { if (max < 100000) max = 100000; print max }' "$file")"
  start=$(( ((max_end + 65535) / 65536) * 65536 ))
  end=$(( start + 65535 ))
  (( end < 4294967295 )) || fail "no safe subordinate-ID range remains in $file"
  usermod "$option" "$start-$end" "$RUNTIME_USER"
}

ensure_subordinate_range /etc/subuid --add-subuids
ensure_subordinate_range /etc/subgid --add-subgids

install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0700 \
  "$RUNTIME_ROOT" \
  "$RUNTIME_HOME" \
  "$RUNTIME_HOME/.config" \
  "$RUNTIME_HOME/.config/containers" \
  "$RUNTIME_ROOT/storage" \
  "$RUNTIME_ROOT/tmp"

# Permit traversal to this account's directory but explicitly deny access to the
# existing Factory Podman graphroot beneath the same secondary mount.
setfacl -m "u:$RUNTIME_USER:--x" /var/mnt/podman
setfacl -m "u:$SUDO_USER:--x" "$RUNTIME_ROOT"
setfacl -m "u:$RUNTIME_USER:---" "$factory_storage_parent"

storage_config="$RUNTIME_HOME/.config/containers/storage.conf"
storage_tmp="$(mktemp)"
trap 'rm -f "$storage_tmp"' EXIT
cat > "$storage_tmp" <<'EOF'
[storage]
driver = "overlay"
graphroot = "/var/mnt/podman/obot-runtime/storage"
runroot = "/run/obot-runtime/storage"
EOF
if [[ -e "$storage_config" ]]; then
  cmp -s "$storage_tmp" "$storage_config" || fail "existing $storage_config differs from the dedicated secondary-disk configuration; review it manually"
else
  install -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0600 "$storage_tmp" "$storage_config"
fi

service_tmp="$(mktemp)"
socket_tmp="$(mktemp)"
tmpfiles_tmp="$(mktemp)"
trap 'rm -f "$storage_tmp" "$service_tmp" "$socket_tmp" "$tmpfiles_tmp"' EXIT
cat > "$service_tmp" <<EOF
# Managed by integrations/bazzite/obot/setup-runtime.sh
[Unit]
Description=Dedicated rootless Podman API for Obot MCP workloads
Requires=$SERVICE_NAME.socket
After=$SERVICE_NAME.socket network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
User=$RUNTIME_USER
Group=$RUNTIME_USER
Environment=HOME=$RUNTIME_HOME
Environment=XDG_RUNTIME_DIR=/run/obot-runtime
Environment=CONTAINERS_STORAGE_CONF=$storage_config
Environment=TMPDIR=$RUNTIME_ROOT/tmp
RuntimeDirectory=obot-runtime
RuntimeDirectoryMode=0700
RuntimeDirectoryGroup=$RUNTIME_USER
ExecStart=/usr/bin/podman system service --time=0
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
Delegate=yes
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$RUNTIME_ROOT /run/obot-runtime
InaccessiblePaths=$factory_storage_parent -/run/podman/podman.sock -/var/run/docker.sock

EOF
cat > "$socket_tmp" <<EOF
# Managed by integrations/bazzite/obot/setup-runtime.sh
[Unit]
Description=Operator-only API socket for the Obot rootless Podman runtime

[Socket]
ListenStream=$RUNTIME_API_SOCKET
SocketUser=$SUDO_USER
SocketGroup=$operator_group
SocketMode=0660
DirectoryMode=0710
RemoveOnStop=no

[Install]
WantedBy=sockets.target
EOF
cat > "$tmpfiles_tmp" <<EOF
# Managed by integrations/bazzite/obot/setup-runtime.sh
d $RUNTIME_API_DIR 0710 $SUDO_USER $operator_group -
EOF

install -o root -g root -m 0644 "$service_tmp" "$SERVICE_PATH"
install -o root -g root -m 0644 "$socket_tmp" "$SOCKET_PATH"
install -o root -g root -m 0644 "$tmpfiles_tmp" "$TMPFILES_PATH"
systemd-tmpfiles --create "$TMPFILES_PATH"
systemctl daemon-reload
systemctl stop "$SERVICE_NAME.socket" >/dev/null 2>&1 || true
systemctl stop "$SERVICE_NAME.service" >/dev/null 2>&1 || true
systemctl reset-failed "$SERVICE_NAME.service"
systemctl enable --now "$SERVICE_NAME.socket"

api_url="unix://$RUNTIME_API_SOCKET"
graphroot=""
rootless=""
for _ in $(seq 1 10); do
  runtime_info="$(timeout --kill-after=1 3 podman --remote --url "$api_url" info --format '{{.Store.GraphRoot}}|{{.Host.Security.Rootless}}' 2>/dev/null || true)"
  IFS='|' read -r graphroot rootless <<< "$runtime_info"
  [[ -n "$graphroot" && "$rootless" == true ]] && break
  sleep 1
done
[[ -n "$graphroot" ]] || fail "the dedicated rootless Podman API did not become ready; inspect systemd status and sanitized service errors"
[[ "$(realpath "$graphroot")" == "$RUNTIME_ROOT"/* ]] || fail "runtime graphroot $graphroot is outside $RUNTIME_ROOT"
[[ "$(findmnt -n -o TARGET -T "$graphroot")" == /var/mnt/podman ]] || fail "runtime graphroot is not on the secondary disk"
[[ "$rootless" == true ]] || fail "the Obot runtime Podman service is not rootless"
[[ -S "$RUNTIME_API_SOCKET" ]] || fail "runtime API socket was not created"
[[ "$(stat -c '%U:%G %a' "$RUNTIME_API_SOCKET")" == "$SUDO_USER:$operator_group 660" ]] || fail "runtime API socket is not restricted to the Bazzite operator group"
runuser -u "$RUNTIME_USER" -- test ! -x "$factory_storage_parent" || fail "the Obot runtime account can traverse the Factory graphroot"

echo "Dedicated Obot rootless Podman service is active."
echo "Runtime account: $RUNTIME_USER"
echo "Runtime graphroot: $graphroot"
echo "Runtime API socket: $RUNTIME_API_SOCKET (operator-only socket; mount it only into Obot)"
