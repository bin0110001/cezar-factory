#!/usr/bin/env bash
set -Eeuo pipefail

# Validate already-deployed services on both hosts from an operator workstation.
# Bazzite is managed through the named Windows Podman remote connection; only
# host-local OpenHands checks are streamed over SSH.
# Set BAZZITE_SSH_TARGET and MAC_MINI_SSH_TARGET to SSH destinations or aliases.

: "${BAZZITE_SSH_TARGET:?Set BAZZITE_SSH_TARGET=bazzite}"
: "${MAC_MINI_SSH_TARGET:?Set MAC_MINI_SSH_TARGET=caffeinator@192.168.86.60}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAC_MINI_FACTORY_DIR="${MAC_MINI_FACTORY_DIR:-$HOME/cezar-factory}"

command -v ssh >/dev/null || { echo "ssh is required" >&2; exit 1; }
[[ "$MAC_MINI_FACTORY_DIR" != *"'"* && "$MAC_MINI_FACTORY_DIR" != *'"'* ]] || { echo "invalid MAC_MINI_FACTORY_DIR" >&2; exit 2; }

PODMAN_CONNECTION="${PODMAN_CONNECTION:-bazzite}"
BAZZITE_HEALTH_BASE_URL="${BAZZITE_HEALTH_BASE_URL:-http://192.168.86.69}"
PODMAN_CONNECTION="$PODMAN_CONNECTION" BAZZITE_HEALTH_BASE_URL="$BAZZITE_HEALTH_BASE_URL" \
  bash "$ROOT_DIR/scripts/deploy/deploy-bazzite.sh" --validate-only

ssh "$BAZZITE_SSH_TARGET" 'tr -d "\\r" | bash -s --' < "$ROOT_DIR/scripts/deploy/validate-openhands-workspace.sh"
ssh "$BAZZITE_SSH_TARGET" 'tr -d "\\r" | bash -s --' < "$ROOT_DIR/scripts/deploy/validate-openhands-acp.sh"
ssh "$MAC_MINI_SSH_TARGET" "cd '$MAC_MINI_FACTORY_DIR' && bash scripts/deploy/deploy-vllm-mac.sh --validate-only"
