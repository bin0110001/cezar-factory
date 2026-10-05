#!/usr/bin/env bash
set -Eeuo pipefail

# Validate already-deployed services on both configured hosts from an operator workstation.
# The control plane is managed through its named Podman remote connection; only
# host-local OpenHands checks are streamed over SSH.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT_DIR/scripts/deploy/lib-topology.sh"
load_factory_topology "$ROOT_DIR"
CONTROL_PLANE_SSH_TARGET="${CONTROL_PLANE_SSH_TARGET:-$FACTORY_CONTROL_PLANE_SSH_TARGET}"
MODEL_HOST_SSH_TARGET="${MODEL_HOST_SSH_TARGET:-$FACTORY_MODEL_HOST_SSH_TARGET}"
MODEL_HOST_FACTORY_DIR="${MODEL_HOST_FACTORY_DIR:-${FACTORY_MODEL_HOST_FACTORY_DIR:-$HOME/cezar-factory}}"

command -v ssh >/dev/null || { echo "ssh is required" >&2; exit 1; }
[[ "$MODEL_HOST_FACTORY_DIR" != *"'"* && "$MODEL_HOST_FACTORY_DIR" != *'"'* ]] || { echo "invalid MODEL_HOST_FACTORY_DIR" >&2; exit 2; }

PODMAN_CONNECTION="${PODMAN_CONNECTION:-$FACTORY_CONTROL_PLANE_PODMAN_CONNECTION}"
BAZZITE_HEALTH_BASE_URL="${BAZZITE_HEALTH_BASE_URL:-${FACTORY_CONTROL_PLANE_HEALTH_BASE_URL:-http://$FACTORY_CONTROL_PLANE_ADDRESS}}"
PODMAN_CONNECTION="$PODMAN_CONNECTION" BAZZITE_HEALTH_BASE_URL="$BAZZITE_HEALTH_BASE_URL" \
  bash "$ROOT_DIR/scripts/deploy/deploy-bazzite.sh" --validate-only

ssh "$CONTROL_PLANE_SSH_TARGET" 'tr -d "\\r" | bash -s --' < "$ROOT_DIR/scripts/deploy/validate-openhands-workspace.sh"
ssh "$CONTROL_PLANE_SSH_TARGET" 'tr -d "\\r" | bash -s --' < "$ROOT_DIR/scripts/deploy/validate-openhands-acp.sh"
ssh "$MODEL_HOST_SSH_TARGET" "cd '$MODEL_HOST_FACTORY_DIR' && bash scripts/deploy/deploy-vllm-mac.sh --validate-only"
