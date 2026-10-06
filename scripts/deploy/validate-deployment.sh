#!/usr/bin/env bash
set -Eeuo pipefail

target="${1:-}"
vllm_api_key="${VLLM_API_KEY:-}"
litellm_api_key="${LITELLM_MASTER_KEY:-}"
base_url="${2:-}"
case "$target" in
  bazzite)
    base_url="${base_url:-${BAZZITE_HEALTH_BASE_URL:-http://127.0.0.1}}"
    checks=(
      "${base_url%/}:3000/health|"
      "${base_url%/}:3001/health|"
      "${base_url%/}:8888/health|"
      "${base_url%/}:4001/health|${litellm_api_key}"
      "${base_url%/}:3002/api/public/health|"
      "${base_url%/}:9090/-/ready|"
      "${base_url%/}:3003/api/health|"
    )
    ;;
  vllm)
    checks=("${VLLM_HEALTH_URL:-http://127.0.0.1:8000/health}|${vllm_api_key}" "${VLLM_MODELS_URL:-http://127.0.0.1:8000/v1/models}|${vllm_api_key}")
    ;;
  *) echo 'usage: validate-deployment.sh bazzite [base-url]|vllm' >&2; exit 2 ;;
esac

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
failed=0
for check in "${checks[@]}"; do
  url="${check%%|*}"
  check_key="${check#*|}"
  curl_args=(--fail --silent --show-error --max-time "${HEALTHCHECK_TIMEOUT_SECONDS:-10}")
  [[ -n "$check_key" ]] && curl_args+=(--header "Authorization: Bearer $check_key")
  if curl "${curl_args[@]}" "$url" >/dev/null; then
    printf 'ok   %s\n' "$url"
  else
    printf 'FAIL %s\n' "$url" >&2
    failed=1
  fi
done
exit "$failed"
