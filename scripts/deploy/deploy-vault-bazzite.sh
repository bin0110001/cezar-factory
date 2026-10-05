#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy only Vault to Bazzite without restarting the existing Factory stack.
# Run from the repository checkout on Bazzite, or set VAULT_CONFIG_PATH to an
# already-copied absolute configuration directory.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_PATH="${VAULT_CONFIG_PATH:-${ROOT_DIR}/integrations/bazzite/vault-config}"
IMAGE="${VAULT_IMAGE:-docker.io/hashicorp/vault:1.20.0}"
NAME="${VAULT_CONTAINER_NAME:-cezar-factory-vault}"

[[ -f "$CONFIG_PATH/vault.hcl" ]] || { echo "missing Vault configuration: $CONFIG_PATH/vault.hcl" >&2; exit 1; }
podman pull "$IMAGE"
podman run -d --replace --name "$NAME" \
  --restart unless-stopped \
  --cap-add IPC_LOCK \
  --publish 127.0.0.1:8200:8200 \
  --volume "${CONFIG_PATH}:/vault/config:ro,Z" \
  --volume cezar-factory-vault-data:/vault/file:Z \
  "$IMAGE" server

for _ in $(seq 1 20); do
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 http://127.0.0.1:8200/v1/sys/health || true)"
  case "$code" in
    200|429|472|473|501|503) break ;;
  esac
  status="$(podman inspect --format '{{.State.Status}}' "$NAME")"
  [[ "$status" == running ]] || { podman logs "$NAME" >&2; exit 1; }
  sleep 1
done

case "${code:-000}" in
  200|429|472|473|501|503) ;;
  *) echo "Vault did not answer its health endpoint" >&2; exit 1 ;;
esac

echo "Vault is running and sealed. Initialize and unseal it from a trusted Bazzite shell."
