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
