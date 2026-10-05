# Native model-host vLLM deployment

The topology-assigned model host is the only host assigned model-serving work.
Keep model weights and runtime state on it; do not copy them to the control-plane host.

The Mac mini runs vLLM natively from `~/.venv-vllm-metal` under a per-user
launchd agent. Do not use the Podman compose file for model serving; it is kept
only as a reference for the endpoint contract.

Before enabling this endpoint:

1. Choose and pin one small general model and one coding model.
2. Set their exact model IDs in the host-local environment.
3. Bind the OpenAI-compatible API to the trusted LAN only.
4. Keep the endpoint on the trusted LAN; the current native launchd plist does
   not configure an API key, so do not expose port 8000 outside that network.
5. Validate `/v1/models` and a minimal chat completion from the control-plane host.
6. Record latency, throughput, and peak memory in the deployment notes.

The checked-in deployment script loads
`~/Library/LaunchAgents/com.vllm.qwen35.plist`, validates `/health` and
`/v1/models`, and supports `--down` for stopping the agent.

The selected general model can be managed with the same script using the
localhost-only profile:

```bash
./scripts/deploy/deploy-vllm-mac.sh --profile general
./scripts/deploy/deploy-vllm-mac.sh --profile general --validate-only
```

That profile uses `com.vllm.gemma4.plist` on port 8001 and a reduced 4,096-token
context so it can coexist with the coding model on the 16 GB Mac mini.

## Trusted proxy mode

For the coding endpoint, use the checked-in user-level proxy deployment after
choosing a loopback backend port:

```bash
VLLM_PROXY_API_KEY=host-local-secret \
VLLM_BACKEND_PORT=8002 \
./scripts/deploy/deploy-vllm-trusted-proxy-mac.sh
```

The proxy binds the public port, forwards only to loopback, enforces the
allowlisted client CIDR and bearer token, and is managed by launchd. Keep the
proxy credential aligned with the control-plane `VLLM_API_KEY`; do not commit it.

Validate the installed local boundary on the Mac with:

```bash
VLLM_PROXY_API_KEY=host-local-secret \
./scripts/deploy/validate-vllm-trusted-proxy-mac.sh
```
