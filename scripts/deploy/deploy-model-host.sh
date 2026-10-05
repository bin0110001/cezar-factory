#!/usr/bin/env bash
set -Eeuo pipefail

# Canonical, topology-driven entrypoint. Native launchd remains the currently
# supported model-host runtime.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo 'Usage: deploy-model-host.sh [--profile qwen|general] [--validate-only] [--down]'
  exit 0
fi
exec "$ROOT_DIR/scripts/deploy/deploy-vllm-mac.sh" "$@"
