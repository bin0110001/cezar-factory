#!/usr/bin/env bash
set -Eeuo pipefail

VAULT_HEALTH_URL="${VAULT_HEALTH_URL:-http://127.0.0.1:8200/v1/sys/health}"
code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time "${HEALTHCHECK_TIMEOUT_SECONDS:-10}" "$VAULT_HEALTH_URL" || true)"

case "$code" in
  200) echo "Vault is initialized and unsealed." ;;
  501) echo "Vault is reachable but not initialized." ;;
  503) echo "Vault is reachable but sealed." ;;
  429|472|473) echo "Vault is reachable but in a standby/replication state (HTTP $code)." ;;
  *) echo "Vault health endpoint was unreachable or returned HTTP $code." >&2; exit 1 ;;
esac
