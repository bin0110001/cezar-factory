#!/usr/bin/env bash
set -Eeuo pipefail

# Validate the user-level trusted proxy locally on the Mac mini.
# Bazzite-to-proxy reachability is validated separately from the operator host.

PROXY_URL="${VLLM_PROXY_URL:-http://127.0.0.1:8000}"
BACKEND_URL="${VLLM_BACKEND_URL:-http://127.0.0.1:8002}"
PROXY_API_KEY="${VLLM_PROXY_API_KEY:-}"

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
[[ -n "$PROXY_API_KEY" ]] || { echo 'VLLM_PROXY_API_KEY is required' >&2; exit 1; }

status_code() {
  local url="$1"; shift
  curl --silent --show-error --max-time "${HEALTHCHECK_TIMEOUT_SECONDS:-10}" "$@" -o /dev/null -w '%{http_code}' "$url"
}
expect() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf 'ok   %s (%s)\n' "$name" "$actual"
  else
    printf 'FAIL %s (expected %s, got %s)\n' "$name" "$expected" "$actual" >&2
    return 1
  fi
}

expect 'proxy rejects unauthenticated local access' 401 "$(status_code "$PROXY_URL/health")"
expect 'proxy accepts authenticated local access' 200 "$(status_code "$PROXY_URL/health" -H "Authorization: Bearer $PROXY_API_KEY")"
expect 'loopback backend remains healthy' 200 "$(status_code "$BACKEND_URL/health")"
