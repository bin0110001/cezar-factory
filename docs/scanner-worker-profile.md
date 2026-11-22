# Isolated scanner worker profile (#605)

`cezar/packages/cezar/src/server/verification/scanner-worker-profile.ts` describes how a
vulnerability/quality scanner runs on a verification worker. It is a profile plus enforcement
hooks, not a new runner: pure functions build a rootless Podman argv and refuse anything wider.

- **Environment**: allowlist only (`envAllowlist`, default `PATH LANG TZ TMPDIR`). A secret-shaped
  name (`SECRET_NAME_RE`) in the allowlist is a configuration error, so `GITHUB_TOKEN`, `GH_TOKEN`,
  `*_KEY` and similar never reach the scanner.
- **Mounts**: source and artifacts are bind-mounted `ro=true`; the root filesystem is `--read-only`;
  the container runs as `65534`, drops all capabilities and sets `no-new-privileges`.
- **Egress**: `--network=none` during the `scan` phase. Only the `db-update` phase has a network,
  and it must name hosts from `advisoryDbHosts`.
- **Redaction**: `redactScannerOutput` applies `core/secret-redaction` (host secret values, token
  shapes) plus caller-supplied planted values to logs, findings and artifacts.
- **Portability**: Linux/macOS need rootless Podman. Windows has no equivalent mount/egress
  primitive, so `planScannerEnforcement` fails closed with `unsupported_platform`; so does a missing
  runtime (`no_container_runtime`). Run scanners on a Linux worker.

Assumption: provider contract #598 has not landed, so the profile is independent of it.

## OCR worker deployment

`cezar/ocr-worker` is a separate, opt-in compose service for #783. Enable it with the `ocr` profile only after setting
`CEZAR_WORKSPACE` to the one repository mount the worker may read, plus `OCR_WORKER_TOKEN` (at least 32 random
characters), `OCR_GATEWAY_TOKEN`, `OCR_GATEWAY_URL` (the LiteLLM `/v1/chat/completions` endpoint),
`OCR_MODEL_ALIAS`, `OCR_RULE_DIGEST`, and `OCR_POLICY_DIGEST`.
Set `CEZ_OCR_ENABLED=1` only when those values are present. The OCR worker joins the private `cezar-ocr-private`
network, mounts the checkout read-only, drops Linux capabilities, runs as uid 10001, and has a read-only root filesystem
and bounded tmpfs/output/resources. Attach the local LiteLLM service to that private network and keep its membership
limited to Cezar, the OCR worker, and LiteLLM; verify the host runtime gives that internal network no general egress.
Do not mount a GitHub credential.

For each OCR review, the worker routes model requests through a loopback metering proxy. It creates a usage receipt only
when every LiteLLM response has both token usage and a billed cost, then binds the aggregate receipt to the OCR session
ID. If the gateway omits either value, a request fails, or OCR returns no session ID, the worker exposes no receipt and
the run remains `unknown`; it cannot be treated as a clean review.
