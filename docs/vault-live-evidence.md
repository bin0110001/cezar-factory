# Vault live evidence

Verified on 2026-10-04 against Bazzite host `Chinchilla`.

- Image: `docker.io/hashicorp/vault:1.20.0`.
- Container: `cezar-factory-vault`, running under rootless Podman.
- API mapping: `127.0.0.1:8200` only; it is not LAN-published.
- Storage: persistent Podman volume `cezar-factory-vault-data` using Vault
  integrated Raft storage.
- `GET /v1/sys/health` returns HTTP 501. This confirms the service is
  reachable and intentionally uninitialized; no recovery keys or initial root
  token have been generated or recorded by the deployment.

The next operator action is a trusted, out-of-band initialization and unseal,
followed by creation of least-privilege service policies. The initialization
output must be stored in the approved secret/recovery channel, never in this
repository or deployment logs.
