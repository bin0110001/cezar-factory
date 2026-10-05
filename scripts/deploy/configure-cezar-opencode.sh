#!/usr/bin/env bash
set -Eeuo pipefail

container=${CEZAR_CONTAINER_NAME:-cezar}
litellm_container=${LITELLM_CONTAINER_NAME:-cezar-factory-litellm}
secret=${CEZAR_OPENCODE_LITELLM_SECRET:-cezar-litellm-api}
unit="$HOME/.config/systemd/user/container-${container}.service"

podman container exists "$container" || { echo "Missing Cezar container: $container" >&2; exit 1; }
podman container exists "$litellm_container" || { echo "Missing LiteLLM container: $litellm_container" >&2; exit 1; }
test -f "$unit" || { echo "Missing systemd unit: $unit" >&2; exit 1; }
curl --fail --silent http://127.0.0.1:4001/health/readiness >/dev/null || {
  echo "LiteLLM is not healthy on Bazzite localhost:4001." >&2
  exit 1
}

podman exec "$litellm_container" sh -c 'test -n "$LITELLM_MASTER_KEY"' || {
  echo "LiteLLM has no LITELLM_MASTER_KEY configured." >&2
  exit 1
}
if ! podman secret exists "$secret"; then
  podman exec "$litellm_container" sh -c 'printf "%s" "$LITELLM_MASTER_KEY"' |
    podman secret create "$secret" - >/dev/null
fi

podman exec --user 10001:10001 "$container" mkdir -p \
  /home/cezar/.local/share/opencode/bin \
  /home/cezar/.local/share/opencode/state \
  /home/cezar/.local/share/opencode/cache

podman exec -i --user 0:0 "$container" sh -c \
  'cat > /home/cezar/.config/opencode/opencode.json' <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "litellm/factory-code",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Bazzite LiteLLM (local)",
      "options": {
        "baseURL": "http://host.containers.internal:4001/v1",
        "apiKey": "{env:OPENAI_API_KEY}"
      },
      "models": {
        "factory-code": { "name": "Factory Code", "limit": { "context": 16384, "output": 4096 } },
        "factory-small": { "name": "Factory Small", "limit": { "context": 16384, "output": 512 } }
      }
    }
  }
}
JSON

podman exec -i --user 10001:10001 "$container" sh -c \
  'cat > /home/cezar/.local/share/opencode/bin/opencode' <<'SH'
#!/bin/sh
set -eu
export OPENAI_API_KEY="$(cat /run/secrets/litellm-master-key)"
export XDG_CONFIG_HOME=/home/cezar/.config
export XDG_DATA_HOME=/home/cezar/.local/share
export XDG_STATE_HOME=/home/cezar/.local/share/opencode/state
export XDG_CACHE_HOME=/home/cezar/.local/share/opencode/cache
exec /usr/local/bin/opencode "$@"
SH
podman exec --user 10001:10001 "$container" chmod 0755 \
  /home/cezar/.local/share/opencode/bin/opencode

python3 - "$unit" "$secret" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
secret = sys.argv[2]
text = path.read_text()
if "--name cezar" not in text:
    raise SystemExit("Unexpected Cezar systemd unit; refusing to edit it.")
if "--secret " + secret not in text:
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if "--network pasta" in line:
            lines.insert(index + 1, f"\t--secret {secret},target=litellm-master-key,uid=10001,gid=10001,mode=0400 \\\n")
            break
    else:
        raise SystemExit("Could not locate the container network option in the service unit.")
    text = "".join(lines)
if "--env PATH=" in text and "/home/cezar/.local/share/opencode/bin:" not in text:
    text = text.replace(
        "--env PATH=",
        "--env PATH=/home/cezar/.local/share/opencode/bin:",
        1,
    )
path.write_text(text)
PY

systemctl --user daemon-reload
systemctl --user restart "container-${container}.service"
systemctl --user is-active --quiet "container-${container}.service"
podman exec "$container" sh -c 'test -r /run/secrets/litellm-master-key'
podman exec --user 10001:10001 "$container" opencode --version
echo "OpenCode is configured for Bazzite LiteLLM and its credential is mounted as a Podman secret."
