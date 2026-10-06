#!/usr/bin/env bash
set -Eeuo pipefail

# Install the optional user-level trusted-client proxy for native Mac vLLM.
# The proxy is intended to listen on the public vLLM port while vLLM itself is
# moved to loopback on a separate backend port by the operator.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${VLLM_ENV_FILE:-$ROOT_DIR/integrations/mac-mini/vllm/.env}"
PROXY_SCRIPT="${VLLM_PROXY_SCRIPT:-$HOME/.local/libexec/vllm-trusted-proxy.py}"
PLIST_PATH="${VLLM_PROXY_PLIST_PATH:-$HOME/Library/LaunchAgents/com.vllm.trusted-proxy.plist}"
PROXY_PORT="${VLLM_PROXY_PORT:-8000}"
BACKEND_PORT="${VLLM_BACKEND_PORT:-8002}"
ALLOWED_CLIENT="${VLLM_PROXY_ALLOWED_CLIENT:-192.168.86.69/32}"
VALIDATE_ONLY=0
DOWN=0

usage() { echo 'Usage: deploy-vllm-trusted-proxy-mac.sh [--validate-only] [--down]'; }
while (($#)); do
  case "$1" in
    --validate-only) VALIDATE_ONLY=1 ;;
    --down) DOWN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v launchctl >/dev/null || { echo 'launchctl is required; run this on macOS' >&2; exit 1; }
command -v plutil >/dev/null || { echo 'plutil is required' >&2; exit 1; }
[[ -f "$ROOT_DIR/scripts/deploy/vllm-trusted-proxy.py" ]] || { echo 'proxy script missing' >&2; exit 1; }
mkdir -p "$(dirname "$PROXY_SCRIPT")" "$(dirname "$PLIST_PATH")"
cp "$ROOT_DIR/scripts/deploy/vllm-trusted-proxy.py" "$PROXY_SCRIPT"
chmod 700 "$PROXY_SCRIPT"

domain="gui/$(id -u)"
service="${domain}/com.vllm.trusted-proxy"
if (( DOWN )); then
  launchctl bootout "$domain" "$PLIST_PATH" 2>/dev/null || true
  exit 0
fi

api_key="${VLLM_PROXY_API_KEY:-}"
key_xml=""
if [[ -n "$api_key" ]]; then
  key_xml="<key>EnvironmentVariables</key><dict><key>VLLM_PROXY_API_KEY</key><string>$api_key</string></dict>"
fi
allowed_xml=""
IFS=',' read -r -a allowed_clients <<< "$ALLOWED_CLIENT"
for client in "${allowed_clients[@]}"; do
  [[ -n "$client" ]] || continue
  allowed_xml+="<string>--allowed-client</string><string>$client</string>"
done
[[ -n "$allowed_xml" ]] || { echo 'VLLM_PROXY_ALLOWED_CLIENT must contain at least one CIDR' >&2; exit 1; }
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.vllm.trusted-proxy</string>
<key>ProgramArguments</key><array>
<string>$(command -v python3)</string><string>$PROXY_SCRIPT</string>
<string>--listen-host</string><string>0.0.0.0</string>
<string>--listen-port</string><string>$PROXY_PORT</string>
<string>--upstream</string><string>http://127.0.0.1:$BACKEND_PORT</string>
$allowed_xml
</array>
$key_xml
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
plutil -lint "$PLIST_PATH" >/dev/null
if (( ! VALIDATE_ONLY )); then
  launchctl bootout "$domain" "$PLIST_PATH" 2>/dev/null || true
  launchctl bootstrap "$domain" "$PLIST_PATH"
  launchctl kickstart -k "$service"
fi
echo "trusted proxy configured for $ALLOWED_CLIENT on port $PROXY_PORT -> 127.0.0.1:$BACKEND_PORT"
