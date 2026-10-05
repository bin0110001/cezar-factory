# HashiCorp Vault on Bazzite

Vault is the Factory's secret-management system for GitHub credentials,
gateway/API credentials, and shared project secrets. It runs as a persistent,
single-node Raft service on Bazzite. It is deliberately independent from the
main compose rollout so it can be introduced without restarting Cezar,
OpenHands, or the observability services.

The API is published only as `127.0.0.1:8200` on Bazzite. Within the Factory
Compose network, the service name is `vault` and the API is `http://vault:8200`.
It is not LAN-exposed. TLS must be configured before expanding either boundary.

## Deploy

Copy the `integrations/bazzite/vault-config/` directory to Bazzite (including
`vault.hcl`, mode `0644`) and run:

```bash
VAULT_CONFIG_PATH="$HOME/cezar-factory-vault-config" \
  bash scripts/deploy/deploy-vault-bazzite.sh
```

The script creates the persistent `cezar-factory-vault-data` Podman volume and
starts `cezar-factory-vault`. It intentionally does not initialize or unseal
Vault, because those operations generate recovery material that must be
captured through an approved secure channel.

From a trusted Bazzite shell, initialize with a suitable key-shares/threshold
policy, store the recovery keys and initial root token in the approved offline
or organizational secret store, then unseal Vault. Do not save initialization
output in this repository, shell history, CI logs, `.env`, or a Podman image.

Confirm that the server is reachable (a newly deployed server is expected to
report "not initialized") with:

```bash
bash scripts/deploy/validate-vault-bazzite.sh
```

After bootstrap, create least-privilege policies and short-lived tokens for
each Factory service. Migrate one credential class at a time and retain the
host-local break-glass configuration until the service proves it can renew and
read its Vault secret.
