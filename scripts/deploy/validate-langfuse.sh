#!/usr/bin/env bash
set -Eeuo pipefail

base_url="${LANGFUSE_BASE_URL:-http://127.0.0.1:3002}"
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
health_file="$(mktemp)"
trap 'rm -f -- "$health_file"' EXIT

curl --fail --silent --show-error --max-time "${HEALTHCHECK_TIMEOUT_SECONDS:-10}" \
  "${base_url%/}/api/public/health" >"$health_file"
grep -Eq '"status"[[:space:]]*:[[:space:]]*"OK"' "$health_file" || {
  echo 'Langfuse health endpoint did not report status OK' >&2
  exit 1
}
printf 'ok   %s/api/public/health\n' "${base_url%/}"
