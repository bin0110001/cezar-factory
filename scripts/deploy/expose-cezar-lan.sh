#!/usr/bin/env bash
set -Eeuo pipefail

# Recreate the locally built Cezar container with the same image, environment,
# command, and persistent volumes, publishing its cockpit/API only on Bazzite's
# trusted LAN address. Keep the old container stopped for rollback.
container=cezar
replacement=cezar-lan-replacement
backup=cezar-before-lan-bind
lan_address=${CEZAR_LAN_ADDRESS:-192.168.86.69}

if ! podman container exists "$container"; then
  echo "Container '$container' was not found." >&2
  exit 1
fi
if podman container exists "$replacement" || podman container exists "$backup"; then
  echo "A replacement or rollback container already exists; inspect it before continuing." >&2
  exit 1
fi

python3 - "$container" "$replacement" "$lan_address" <<'PY'
import json
import subprocess
import sys

source, replacement, address = sys.argv[1:]
spec = json.loads(subprocess.check_output(["podman", "inspect", source]))[0]
config, host = spec["Config"], spec["HostConfig"]
args = ["podman", "create", "--name", replacement]

restart = host.get("RestartPolicy", {}).get("Name")
if restart:
    args += ["--restart", restart]
network = host.get("NetworkMode")
if network and network not in ("default", "bridge"):
    args += ["--network", network]
args += ["--publish", f"{address}:4321:4321"]
if config.get("User"):
    args += ["--user", config["User"]]
if config.get("WorkingDir"):
    args += ["--workdir", config["WorkingDir"]]
for key, value in config.get("Labels", {}).items():
    args += ["--label", f"{key}={value}"]
for value in config.get("Env", []):
    if not value.startswith("HOSTNAME="):
        args += ["--env", value]
for mount in spec.get("Mounts", []):
    if mount.get("Type") != "volume":
        raise SystemExit(f"Unsupported mount type; refusing to recreate: {mount.get('Type')}")
    volume = f"{mount['Name']}:{mount['Destination']}"
    if mount["Destination"] == "/projects":
        volume += ":z"
    args += ["--volume", volume]

entrypoint = config.get("Entrypoint") or []
command = config.get("Cmd") or []
if entrypoint:
    args += ["--entrypoint", entrypoint[0]]
    command = entrypoint[1:] + command
args += [config["Image"]] + command
subprocess.run(args, check=True)
PY

rollback() {
  podman stop "$container" >/dev/null 2>&1 || true
  podman rename "$container" "$replacement" >/dev/null 2>&1 || true
  podman rename "$backup" "$container" >/dev/null 2>&1 || true
  podman start "$container" >/dev/null 2>&1 || true
}

podman stop "$container"
podman rename "$container" "$backup"
podman rename "$replacement" "$container"
if ! podman start "$container" >/dev/null; then
  rollback
  exit 1
fi

healthy=false
for _ in $(seq 1 20); do
  if curl --fail --silent "http://${lan_address}:4321/api/v1/health" >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  echo "Cezar did not pass its LAN health check; restoring the previous container." >&2
  rollback
  exit 1
fi

echo "Cezar is healthy at http://${lan_address}:4321"
echo "Previous container retained, stopped, as '$backup'."
