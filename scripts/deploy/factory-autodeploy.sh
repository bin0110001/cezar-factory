#!/usr/bin/env bash
set -Eeuo pipefail

# Runs on the Bazzite host (systemd timer: integrations/bazzite/factory-autodeploy.timer).
# Fast-forwards the tested stable checkout, verifies the Cezar mount's source and content,
# then reconciles every explicitly configured automation target. An unchanged source SHA still
# runs parity and reconciliation so a failed/partial attempt is retried on the next timer tick.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT_DIR/scripts/deploy/lib-topology.sh"
load_factory_topology "$ROOT_DIR"

BRANCH="${FACTORY_DEPLOY_BRANCH:-stable}"
FACTORY_DIR="${FACTORY_DIR:-$FACTORY_CONTROL_PLANE_FACTORY_DIR}"
CONTAINER="${CEZAR_CONTAINER:-cezar}"
RUNTIME_ROOT="${FACTORY_RUNTIME_ROOT:-/projects/cezar-factory}"
STATE_DIR="${FACTORY_AUTODEPLOY_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/cezar-factory/autodeploy}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1 # Kept for compatibility; reconciliation now runs every tick.

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
exec 9>"${FACTORY_AUTODEPLOY_LOCK:-/tmp/factory-autodeploy.lock}"
flock -n 9 || { echo "another autodeploy is running" >&2; exit 0; }

log() { echo "$(date -u +%FT%TZ) factory-autodeploy: $*"; }
json_escape() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

started_at="$(date -u +%FT%TZ)"
source_sha="unknown"
host_version="unknown"
registry_digest="missing"
host_content_digest="unknown"
container_sha="unknown"
container_version="unknown"
container_content_digest="unknown"
sync_output=""
failure=""

write_receipt() {
  local destination="$1" status="$2" message="$3" completed_at tmp
  completed_at="$(date -u +%FT%TZ)"
  tmp="${destination}.tmp.$$"
  umask 077
  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "status": "%s",\n' "$(json_escape "$status")"
    printf '  "startedAt": "%s",\n' "$(json_escape "$started_at")"
    printf '  "completedAt": "%s",\n' "$(json_escape "$completed_at")"
    printf '  "sourceSha": "%s",\n' "$(json_escape "$source_sha")"
    printf '  "version": "%s",\n' "$(json_escape "$host_version")"
    printf '  "registryDigest": "%s",\n' "$(json_escape "$registry_digest")"
    printf '  "parity": {"hostSha": "%s", "containerSha": "%s", "hostContentDigest": "%s", "containerContentDigest": "%s", "hostVersion": "%s", "containerVersion": "%s"},\n' \
      "$(json_escape "$source_sha")" "$(json_escape "$container_sha")" \
      "$(json_escape "$host_content_digest")" "$(json_escape "$container_content_digest")" \
      "$(json_escape "$host_version")" "$(json_escape "$container_version")"
    printf '  "targetReceipts": "%s",\n' "$(json_escape "$sync_output")"
    printf '  "error": "%s"\n' "$(json_escape "$message")"
    printf '}\n'
  } > "$tmp"
  mv -f -- "$tmp" "$destination"
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  if [[ "$exit_code" -ne 0 ]]; then
    failure="${failure:-command failed: ${BASH_COMMAND:-unknown}}"
    write_receipt "$STATE_DIR/last-attempt.json" failure "$failure" || log "could not write failure receipt"
  fi
  exit "$exit_code"
}
trap on_exit EXIT

content_digest() {
  local root="$1"
  local paths=(VERSION workflows skills scripts routing automations)
  [[ -f "$root/config/factory-projects.json" ]] && paths+=(config/factory-projects.json)
  ( cd "$root"
    local digest
    digest="$(find "${paths[@]}" -type f -print0 |
      LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum)"
    printf '%s' "${digest%% *}"
  )
}

cd "$FACTORY_DIR"
if [[ -n "$(git status --porcelain)" ]]; then
  failure="$FACTORY_DIR has uncommitted or untracked changes; not touching it"
  log "BLOCKED: $failure" >&2
  exit 20
fi

git fetch --quiet origin "$BRANCH"
remote_sha="$(git rev-parse FETCH_HEAD)"
local_sha="$(git rev-parse HEAD)"
if [[ "$local_sha" != "$remote_sha" ]]; then
  if ! git merge-base --is-ancestor "$local_sha" "$remote_sha"; then
    failure="$FACTORY_DIR ($local_sha) is not an ancestor of origin/$BRANCH ($remote_sha); not touching it"
    log "BLOCKED: $failure" >&2
    exit 21
  fi
  git checkout --quiet -B "$BRANCH" "$remote_sha"
  log "advanced ${local_sha:0:9} -> ${remote_sha:0:9}"
fi

source_sha="$remote_sha"
host_version="$(tr -d '\r\n' < VERSION)"
registry_path="$FACTORY_DIR/config/factory-projects.json"
if [[ -f "$registry_path" ]]; then
  registry_digest="$(sha256sum "$registry_path" | awk '{print $1}')"
fi
host_content_digest="$(content_digest "$FACTORY_DIR")"

# The read-only source mount has its own persistent writable .git volume for
# Cezar task worktrees. Fast-forward only the root stable index/ref to the
# mounted source after verifying that every committed file already matches;
# linked task worktrees and non-conflicting user data remain untouched.
podman exec "$CONTAINER" bash "$RUNTIME_ROOT/scripts/deploy/reconcile-container-git-metadata.sh" "$source_sha"

# The Cezar server is a local image built from this checkout, not the remote
# image used by the generic Compose template. The deployment script is
# idempotent and rebuilds only when cezar/ changed since the image's revision.
"$FACTORY_DIR/scripts/deploy/deploy-cezar-runtime.sh" "$source_sha"

container_sha="$(podman exec "$CONTAINER" git -C "$RUNTIME_ROOT" rev-parse HEAD)"
container_version="$(podman exec "$CONTAINER" sh -c "tr -d '\r\\n' < '$RUNTIME_ROOT/VERSION'")"
container_content_digest="$(podman exec "$CONTAINER" sh -c '
  cd "$1"
  set -- VERSION workflows skills scripts routing automations
  [ -f config/factory-projects.json ] && set -- "$@" config/factory-projects.json
  digest="$(find "$@" -type f -print0 |
    LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum)"
  printf '%s' "${digest%% *}"
' sh "$RUNTIME_ROOT")"

if [[ "$source_sha" != "$container_sha" || "$host_version" != "$container_version" || "$host_content_digest" != "$container_content_digest" ]]; then
  failure="container parity mismatch: source $source_sha/$container_sha; version $host_version/$container_version; content $host_content_digest/$container_content_digest"
  log "BLOCKED: $failure" >&2
  exit 22
fi

if [[ ! -f "$registry_path" ]]; then
  failure="No target registry at $registry_path; nothing was synchronized"
  log "BLOCKED: $failure" >&2
  exit 23
fi

STORE="${FACTORY_RELEASE_STORE_HOST_DIR:-$HOME/.local/share/cezar-factory/release-store}"
REGISTRY="${FACTORY_PROJECTS_REGISTRY:-$registry_path}"
if ! sync_output="$(python3 "$FACTORY_DIR/scripts/release/factory_activation.py" activate \
  --repo "$FACTORY_DIR" --store "$STORE" --registry "$REGISTRY" --channel "$BRANCH" 2>&1)"; then
  failure="Factory activation failed: $sync_output"
  log "FAILED: $failure" >&2
  exit 24
fi

write_receipt "$STATE_DIR/last-success.json" success ""
write_receipt "$STATE_DIR/last-attempt.json" success ""
trap - EXIT
log "activated Factory $host_version at ${source_sha:0:9}; content ${host_content_digest:0:12}; registry ${registry_digest:0:12}; $sync_output"
