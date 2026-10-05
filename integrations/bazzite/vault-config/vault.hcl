# Single-node Vault for the Factory control plane. The host publishes its API
# only on loopback; services joining the compose network use http://vault:8200.
# Add TLS before exposing this service beyond the host or compose network.
ui = true
disable_mlock = true
api_addr = "http://127.0.0.1:8200"
cluster_addr = "http://vault:8201"

storage "raft" {
  path = "/vault/file"
  node_id = "bazzite-vault-1"
}

listener "tcp" {
  address = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_disable = 1
  redact_addresses = "true"
  redact_cluster_name = "true"
  redact_version = "true"
}
