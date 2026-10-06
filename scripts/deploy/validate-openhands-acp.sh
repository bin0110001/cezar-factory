#!/usr/bin/env bash
set -Eeuo pipefail

# Report ACP runtime/profile readiness without printing credential material.
CONTAINER="${OPENHANDS_CONTAINER:-cezar-factory-openhands}"
BASE_URL="${OPENHANDS_BASE_URL:-http://127.0.0.1:3001}"
REQUIRE_READY=0

usage() {
  cat <<'EOF'
Usage: validate-openhands-acp.sh [--require-ready]

Checks that the deployed OpenHands image contains the Codex and Claude ACP
launchers and reports the active profile kind. Use --require-ready when an
authenticated ACP profile is expected and deployment should fail otherwise.
EOF
}

while (($#)); do
  case "$1" in
    --require-ready) REQUIRE_READY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v podman >/dev/null || { echo "podman is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

for executable in codex-acp claude-agent-acp; do
  podman exec "$CONTAINER" sh -lc "command -v '$executable' >/dev/null"
done

session_key="$(podman inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" \
  | awk -F= '$1 == "LOCAL_BACKEND_API_KEY" {print substr($0, index($0, "=") + 1); exit}')"
[[ -n "$session_key" ]] || { echo "missing OpenHands session key in container environment" >&2; exit 1; }

profiles="$(curl -fsS -H "X-Session-API-Key: $session_key" "$BASE_URL/api/agent-profiles")"
profile_summary="$(printf '%s' "$profiles" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
profiles = payload.get("profiles", [])
active = payload.get("active_agent_profile_id")
current = next((item for item in profiles if item.get("id") == active), None)
if current is None:
    print("none")
else:
    print("{}:{}".format(current.get("name", "unknown"), current.get("agent_kind", "unknown")))
')"

echo "openhands-acp: executables=codex-acp,claude-agent-acp active-profile=$profile_summary"

if (( REQUIRE_READY )) && [[ "$profile_summary" == "none" || "$profile_summary" == *":openhands" ]]; then
  echo "active profile is not an ACP profile" >&2
  exit 1
fi
