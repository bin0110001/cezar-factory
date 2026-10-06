#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy and validate the native Metal vLLM endpoint on the Mac mini.
# No Factory control-plane service belongs on this host.  vLLM runs directly
# from the host virtualenv under launchd; Podman is not used for model serving.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${VLLM_ENV_FILE:-$ROOT_DIR/integrations/mac-mini/vllm/.env}"
PROFILE="qwen"
VALIDATE_ONLY=0
DOWN=0

while (($#)); do
  arg="$1"
  case "$arg" in
    --validate-only) VALIDATE_ONLY=1 ;;
    --down) DOWN=1 ;;
    --profile) shift; PROFILE="${1:-}" ;;
    -h|--help) echo 'Usage: deploy-vllm-mac.sh [--profile qwen|general] [--validate-only] [--down]'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
  shift
done

case "$PROFILE" in
  qwen)
    MODEL_NAME="VLLM_MODEL"
    SERVED_NAME="VLLM_SERVED_MODEL"
    VENV_NAME="VLLM_VENV"
    HOST_NAME="VLLM_HOST"
    PORT_NAME="VLLM_PORT"
    MAX_LEN_NAME="VLLM_MAX_MODEL_LEN"
    DEFAULT_PLIST="$HOME/Library/LaunchAgents/com.vllm.qwen35.plist"
    ;;
  general)
    MODEL_NAME="VLLM_GENERAL_MODEL"
    SERVED_NAME="VLLM_GENERAL_SERVED_MODEL"
    VENV_NAME="VLLM_VENV"
    HOST_NAME="VLLM_GENERAL_HOST"
    PORT_NAME="VLLM_GENERAL_PORT"
    MAX_LEN_NAME="VLLM_GENERAL_MAX_MODEL_LEN"
    DEFAULT_PLIST="$HOME/Library/LaunchAgents/com.vllm.gemma4.plist"
    ;;
  *) echo "profile must be qwen or general: $PROFILE" >&2; exit 2 ;;
esac
PLIST_PATH="${VLLM_PLIST_PATH:-$DEFAULT_PLIST}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v launchctl >/dev/null || { echo "launchctl is required; run this on macOS" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE; copy env.example and choose the model" >&2; exit 1; }
for name in "$MODEL_NAME" "$SERVED_NAME" "$VENV_NAME"; do
  value="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  [[ -n "$value" ]] || { echo "missing required $name in $ENV_FILE" >&2; exit 1; }
done
if grep -Eq '(REPLACE_ON_HOST|REPLACE_WITH_)' "$ENV_FILE"; then
  echo "replace all Mac mini deployment placeholders in $ENV_FILE" >&2
  exit 1
fi
enable_auto_tools="$(grep -E "^VLLM_ENABLE_AUTO_TOOL_CHOICE=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
tool_call_parser="$(grep -E "^VLLM_TOOL_CALL_PARSER=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
tool_xml=""
case "${enable_auto_tools:-false}" in
  true|TRUE|1)
    [[ -n "$tool_call_parser" && "$tool_call_parser" =~ ^[a-zA-Z0-9_]+$ ]] || {
      echo "VLLM_TOOL_CALL_PARSER must be set to a parser name when auto tool choice is enabled" >&2
      exit 1
    }
    tool_xml="<string>--enable-auto-tool-choice</string>
<string>--tool-call-parser</string><string>$tool_call_parser</string>"
    ;;
  false|FALSE|0|'') ;;
  *) echo "VLLM_ENABLE_AUTO_TOOL_CHOICE must be true or false" >&2; exit 1 ;;
esac
mkdir -p "$(dirname "$PLIST_PATH")"
if [[ ! -f "$PLIST_PATH" ]]; then
  venv="$(grep -E "^${VENV_NAME}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  [[ "$venv" == \$HOME/* ]] && venv="$HOME/${venv#\$HOME/}"
  vllm_bin="${VLLM_BIN:-$venv/bin/vllm}"
  model="$(grep -E "^${MODEL_NAME}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  served="$(grep -E "^${SERVED_NAME}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  max_len="$(grep -E "^${MAX_LEN_NAME}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  host="$(grep -E "^${HOST_NAME}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  port="$(grep -E "^${PORT_NAME}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  label="com.vllm.qwen35"
  [[ "$PROFILE" == general ]] && label="com.vllm.gemma4"
  [[ -x "$vllm_bin" ]] || { echo "vLLM executable not found: $vllm_bin" >&2; exit 1; }
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array>
<string>$vllm_bin</string><string>serve</string><string>$model</string>
<string>--host</string><string>${host:-0.0.0.0}</string><string>--port</string><string>${port:-8000}</string>
<string>--served-model-name</string><string>$served</string>
<string>--max-model-len</string><string>${max_len:-16384}</string>
$tool_xml
</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
fi
domain="gui/$(id -u)"
service="${domain}/$(/usr/libexec/PlistBuddy -c 'Print :Label' "$PLIST_PATH")"

if (( DOWN )); then
  launchctl bootout "$domain" "$PLIST_PATH" 2>/dev/null || true
  exit 0
fi

if (( ! VALIDATE_ONLY )); then
  launchctl bootout "$domain" "$PLIST_PATH" 2>/dev/null || true
  launchctl bootstrap "$domain" "$PLIST_PATH"
  launchctl kickstart -k "$service"
fi

"$ROOT_DIR/scripts/deploy/validate-deployment.sh" vllm
