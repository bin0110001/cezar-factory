#!/usr/bin/env bash
set -Eeuo pipefail

# Rebuild the local Cezar image when the cezar source subtree changes, restart
# the systemd-managed container, and require the health and Factory API routes.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_SHA="${1:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
IMAGE="${CEZAR_IMAGE:-localhost/cezar:local}"
CONTAINER="${CEZAR_CONTAINER:-cezar}"
SERVICE="${CEZAR_USER_SERVICE:-container-cezar.service}"
HEALTH_URL="${CEZAR_HEALTH_URL:-http://127.0.0.1:4321/api/v1/health}"
RELEASE_URL="${CEZAR_RELEASE_URL:-http://127.0.0.1:4321/api/v1/factory-release}"

log() { printf '%s deploy-cezar-runtime: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "FAILED: $*" >&2; exit 1; }

[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "expected a full source commit SHA, got '$SOURCE_SHA'"
head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
[[ "$head" == "$SOURCE_SHA" ]] || die "source checkout is at $head, expected $SOURCE_SHA"
[[ -f "$ROOT_DIR/cezar/Dockerfile" ]] || die 'Cezar Dockerfile is missing'
command -v podman >/dev/null || die 'podman is required'
command -v systemctl >/dev/null || die 'systemctl is required'
command -v curl >/dev/null || die 'curl is required'

image_revision=''
if podman image exists "$IMAGE"; then
  image_revision="$(podman image inspect "$IMAGE" --format '{{ index .Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)"
  [[ "$image_revision" == '<no value>' ]] && image_revision=''
fi

needs_build=1
if [[ "$image_revision" =~ ^[0-9a-f]{40}$ ]] && git -C "$ROOT_DIR" cat-file -e "$image_revision^{commit}" 2>/dev/null; then
  if git -C "$ROOT_DIR" diff --quiet "$image_revision" "$SOURCE_SHA" -- cezar/; then
    needs_build=0
  fi
fi

previous_image_id="$(podman image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
if (( needs_build )); then
  log "building $IMAGE from Cezar source at ${SOURCE_SHA:0:9}"
  podman build --label "org.opencontainers.image.revision=$SOURCE_SHA" --tag "$IMAGE" --file "$ROOT_DIR/cezar/Dockerfile" "$ROOT_DIR/cezar" || die 'Cezar image build failed'
fi

target_image_id="$(podman image inspect "$IMAGE" --format '{{.Id}}')"
running_image_id="$(podman inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
service_state="$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)"
healthy=0
if [[ "$running_image_id" == "$target_image_id" && "$service_state" == active ]] && curl --silent --show-error --fail --max-time 5 "$HEALTH_URL" >/dev/null && curl --silent --show-error --fail --max-time 5 "$RELEASE_URL" >/dev/null; then
  healthy=1
fi

if (( ! healthy )); then
  log "restarting $SERVICE with image $target_image_id"
  if ! systemctl --user restart "$SERVICE"; then
    if [[ -n "$previous_image_id" && "$previous_image_id" != "$target_image_id" ]]; then
      podman tag "$previous_image_id" "$IMAGE" || die 'service restart failed and previous image could not be restored'
      systemctl --user restart "$SERVICE" || die 'service restart failed; previous image was restored but service did not recover'
    fi
    die 'Cezar service restart failed'
  fi
fi

for attempt in {1..30}; do
  service_state="$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)"
  running_image_id="$(podman inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
  if [[ "$service_state" == active && "$running_image_id" == "$target_image_id" ]] && curl --silent --show-error --fail --max-time 5 "$HEALTH_URL" >/dev/null && curl --silent --show-error --fail --max-time 5 "$RELEASE_URL" >/dev/null; then
    log "healthy image $target_image_id serves the Factory release API"
    exit 0
  fi
  sleep 2
done

if [[ -n "$previous_image_id" && "$previous_image_id" != "$target_image_id" ]]; then
  log 'health verification failed; restoring the previous image'
  podman tag "$previous_image_id" "$IMAGE" || die 'health check failed and previous image could not be restored'
  systemctl --user restart "$SERVICE" || die 'previous image was restored but the service restart failed'
fi
die "health or Factory release endpoint did not recover at $RELEASE_URL"
