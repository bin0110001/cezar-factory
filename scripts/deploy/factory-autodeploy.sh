#!/usr/bin/env bash
set -Eeuo pipefail

# Runs on the Bazzite host (systemd timer: integrations/bazzite/factory-autodeploy.timer).
# Fast-forwards the Factory checkout that the Cezar container mounts to origin/stable - the ref
# scripts/release/promote-stable.ps1 only advances after the full test suite passes - then
# reconciles Cezar automations from it. Cezar loads Factory workflows and skills from the same
# mount, so this one step updates every project. It never resets, stashes, or overwrites: a dirty
# or diverged checkout stops the run.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT_DIR/scripts/deploy/lib-topology.sh"
load_factory_topology "$ROOT_DIR"

BRANCH="${FACTORY_DEPLOY_BRANCH:-stable}"
FACTORY_DIR="${FACTORY_DIR:-$FACTORY_CONTROL_PLANE_FACTORY_DIR}"
CONTAINER="${CEZAR_CONTAINER:-cezar}"
RUNTIME_ROOT="${FACTORY_RUNTIME_ROOT:-/projects/cezar-factory}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

exec 9>"${FACTORY_AUTODEPLOY_LOCK:-/tmp/factory-autodeploy.lock}"
flock -n 9 || { echo "another autodeploy is running" >&2; exit 0; }

log() { echo "$(date -u +%FT%TZ) factory-autodeploy: $*"; }

cd "$FACTORY_DIR"
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "BLOCKED: $FACTORY_DIR has uncommitted changes; not touching it" >&2
  exit 20
fi

git fetch --quiet origin "$BRANCH"
remote_sha="$(git rev-parse FETCH_HEAD)"
local_sha="$(git rev-parse HEAD)"
changed=0
if [[ "$local_sha" != "$remote_sha" ]]; then
  if ! git merge-base --is-ancestor "$local_sha" "$remote_sha"; then
    log "BLOCKED: $FACTORY_DIR (${local_sha:0:9}) is not an ancestor of origin/$BRANCH (${remote_sha:0:9}); not touching it" >&2
    exit 21
  fi
  git checkout --quiet -B "$BRANCH" "$remote_sha"
  changed=1
  log "advanced ${local_sha:0:9} -> ${remote_sha:0:9}"
fi

if [[ "$changed" == 0 && "$FORCE" == 0 ]]; then
  log "already at origin/$BRANCH (${remote_sha:0:9})"
  exit 0
fi

host_version="$(tr -d '\r\n' < VERSION)"
container_version="$(podman exec "$CONTAINER" sh -c "tr -d '\r\n' < '$RUNTIME_ROOT/VERSION'")"
if [[ "$host_version" != "$container_version" ]]; then
  log "BLOCKED: container sees Factory $container_version but the host checkout is $host_version (is the checkout mounted?)" >&2
  exit 22
fi

podman exec "$CONTAINER" pwsh -NoProfile -File "$RUNTIME_ROOT/scripts/sync-all-automations.ps1"
log "deployed Factory $host_version (${remote_sha:0:9}); workflows, skills and scripts come from the mount, automations reconciled"
