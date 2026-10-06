#!/usr/bin/env bash
set -Eeuo pipefail

base_url="${LANGFUSE_BASE_URL:-http://127.0.0.1:3002}"
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }

curl --fail --silent --show-error --max-time "${HEALTHCHECK_TIMEOUT_SECONDS:-10}" \
  "${base_url%/}/api/public/health" >/dev/null
printf 'ok   %s/api/public/health\n' "${base_url%/}"
