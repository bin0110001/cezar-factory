#!/usr/bin/env bash
set -Eeuo pipefail

# Orders the host's container units after the SYSTEM network-online.target, so Podman's rootless network
# namespace is built once the host has its real address.
#
# Why: a systemd USER unit that says `After=network-online.target` waits for the user manager's own stub of that
# target, which is reached at login, long before the network is up. After a reboot on 2026-11-12 the Cezar and
# application containers started with only a link-local address, the shared rootless namespace was built around it,
# and `host.containers.internal` stayed unreachable until every bridge container was stopped and started again.
# Podman ships `podman-user-wait-network-online.service` for exactly this (containers/podman issue 22197); this
# installs a drop-in that makes the container units want and follow it.
#
# Run it ON THE HOST, as the user that owns the containers. It changes only that user's unit configuration
# (`~/.config/systemd/user/<unit>.d/`), reads nothing else, and is idempotent. It does not restart anything: the
# new ordering applies from the next boot or the next time the units are started.
#
#   install-boot-order.sh [install|remove|check] [unit ...]
#
# With no unit names it uses the three that start containers here: container-cezar.service, podman-restart.service
# and the podman-compose@.service template. FACTORY_SKIP_RELOAD=1 skips `systemctl --user daemon-reload` (tests).

usage() {
  cat <<'USAGE'
Usage: install-boot-order.sh [install|remove|check] [unit ...]
  install  add the drop-in that orders each unit after podman-user-wait-network-online.service (default)
  remove   remove only that drop-in
  check    exit 1 if any unit lacks it
With no unit names: container-cezar.service, podman-restart.service and the podman-compose@.service template.
Run it on the host as the user that owns the containers. It restarts nothing.
USAGE
}
case "${1:-}" in -h|--help|help) usage; exit 0 ;; esac

MODE="${1:-install}"
case "$MODE" in install|remove|check) shift || true ;; *) MODE=install ;; esac
UNITS=("$@")
# The unit name becomes part of a path under the user's systemd directory, so it must look like a unit name.
for unit in "${UNITS[@]}"; do
  if [[ ! "$unit" =~ ^[A-Za-z0-9@._:-]+\.(service|socket|timer|target)$ || "$unit" == .* ]]; then
    echo "install-boot-order: '$unit' is not a systemd unit name" >&2
    usage >&2
    exit 2
  fi
done
(( ${#UNITS[@]} )) || UNITS=(container-cezar.service podman-restart.service 'podman-compose@.service')

CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}"
DROPIN_NAME='10-factory-wait-online.conf'
WAIT_UNIT='podman-user-wait-network-online.service'
CONTENT="$(cat <<EOF
# Managed by scripts/deploy/install-boot-order.sh. Remove with: install-boot-order.sh remove
[Unit]
# A user unit cannot order itself after the system network-online.target; this helper waits for it on its behalf.
Wants=$WAIT_UNIT
After=$WAIT_UNIT
EOF
)"

log() { printf 'install-boot-order: %s\n' "$*"; }
status=0
changed=0

for unit in "${UNITS[@]}"; do
  directory="$CONFIG_HOME/systemd/user/$unit.d"
  file="$directory/$DROPIN_NAME"
  case "$MODE" in
    install)
      if [[ -f "$file" && "$(cat -- "$file")" == "$CONTENT" ]]; then
        log "$unit: already ordered after $WAIT_UNIT"
      else
        mkdir -p -- "$directory"
        printf '%s\n' "$CONTENT" > "$file"
        log "$unit: installed $file"
        changed=1
      fi
      ;;
    remove)
      if [[ -f "$file" ]]; then
        rm -- "$file"
        rmdir --ignore-fail-on-non-empty -- "$directory" 2>/dev/null || true
        log "$unit: removed $file"
        changed=1
      else
        log "$unit: nothing to remove"
      fi
      ;;
    check)
      if [[ -f "$file" && "$(cat -- "$file")" == "$CONTENT" ]]; then
        log "$unit: ordered after $WAIT_UNIT"
      else
        log "$unit: NOT ordered after $WAIT_UNIT"
        status=1
      fi
      ;;
  esac
done

if (( changed )) && [[ "${FACTORY_SKIP_RELOAD:-0}" != 1 ]]; then
  command -v systemctl >/dev/null || { log 'systemctl is not available; reload the user manager yourself'; exit 1; }
  systemctl --user daemon-reload
  log 'reloaded the user manager; the ordering applies from the next start of these units'
fi
exit "$status"
