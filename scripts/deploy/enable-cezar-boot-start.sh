#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT_DIR/scripts/deploy/lib-topology.sh"
load_factory_topology "$ROOT_DIR"
container=${CEZAR_CONTAINER_NAME:-cezar}
lan_address=${CEZAR_LAN_ADDRESS:-$FACTORY_CONTROL_PLANE_ADDRESS}
unit_dir="$HOME/.config/systemd/user"
unit_file="$unit_dir/container-${container}.service"
temp_file=$(mktemp)
trap 'rm -f "$temp_file"' EXIT

podman container exists "$container" || {
  echo "Container '$container' was not found." >&2
  exit 1
}

# The LAN exposure script renames its staging container into place. Podman
# retains the original create command in metadata, so normalize that stale
# staging name in the generated --new service before installing it.
podman generate systemd --new --name --restart-policy=always "$container" >"$temp_file"
if grep -q -- '--name cezar-lan-replacement' "$temp_file"; then
  sed -i 's/--name cezar-lan-replacement/--name cezar/g' "$temp_file"
fi
if ! grep -q -- "--name $container" "$temp_file"; then
  echo "Generated service did not preserve the container name; refusing to install it." >&2
  exit 1
fi

python3 - "$temp_file" "$lan_address" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
lan_publish = f"--publish {sys.argv[2]}:4321:4321"
loopback_publish = "--publish 127.0.0.1:4321:4321"
lines = path.read_text().splitlines(keepends=True)
if not any(lan_publish in line for line in lines):
    raise SystemExit("Generated unit does not publish Cezar on the configured LAN address.")
if not any(loopback_publish in line for line in lines):
    for index, line in enumerate(lines):
        if lan_publish in line:
            lines.insert(index + 1, "\t" + loopback_publish + " \\\n")
            break
path.write_text("".join(lines))
PY

install -D -m 0644 "$temp_file" "$unit_file"
systemctl --user daemon-reload
systemctl --user enable "container-${container}.service"
systemctl --user restart "container-${container}.service"
systemctl --user is-active --quiet "container-${container}.service"

echo "Enabled container-${container}.service for this user."
echo "User lingering: $(loginctl show-user "$USER" -p Linger --value)"
