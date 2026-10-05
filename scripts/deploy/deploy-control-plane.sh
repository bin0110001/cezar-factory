#!/usr/bin/env bash
set -Eeuo pipefail

# Canonical, topology-driven entrypoint. The legacy filename remains available
# for existing operator commands.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo 'Usage: deploy-control-plane.sh [--validate-only] [--down]'
  exit 0
fi
exec "$ROOT_DIR/scripts/deploy/deploy-bazzite.sh" "$@"
