# Obot MCP end-to-end acceptance (issue #172)

A local, reproducible gate for the Obot MCP gateway wiring. It runs on local
compute only (no GitHub Actions) and is part of `tests/run-tests.ps1`.

## Reproduce

```sh
pwsh -NoProfile -File tests/obot-e2e.ps1     # prints OBOT E2E PASSED, exit 0
```

Requirements: `pwsh` 7, `python3` 3.10+, `node` 20+ (tested with Python 3.13 and
Node 22 on Linux). The suite binds `127.0.0.1` on a random port, writes only to a
temp directory, and removes it. Windows is expected to work (the helper and
gateway are portable) but is not part of the tested matrix.

## What it exercises

The stand-in gateway (`tests/obot-e2e/fake-gateway.py`) models the contract the
Factory depends on, not Obot internals: bearer auth, a read-only tool allow-list,
per-project repository scope, a restartable process with persistent token
registry, and an append-only ledger. The real client helper and the committed
client configuration are tested as-is.

| Gate | Evidence in `tests/obot-e2e.ps1` |
| --- | --- |
| G0 Deployment posture | Obot requires authentication and publishes on loopback only; no hosted CI workflow exists. |
| G1 Client wiring | Claude is strict and references the token by name; Codex uses `bearer_token_env_var`; no literal credential in `.mcp.json`; `.env` gitignored; gateway off when URL/token missing; `headers.mjs` emits an accepted header and fails closed without a token. |
| G2 Identity lifecycle | Valid, missing, unknown, expired, revoked and rotated-out tokens; a stale token reaches the gateway and is denied there. |
| G3 Authorization and isolation | No write tool listed or callable; project A and B cannot read each other's repositories; concurrent runs do not interfere. |
| G4 Telemetry and recovery | Outage fails closed; restart keeps the registry and does not resurrect revoked identities; malformed requests rejected; ledger events correlate to a run/attempt trace ID, carry a reason on every denial, and hold no credential; the token registry stores hashes; cleanup leaves nothing behind. |

## Fail-closed semantics

- No URL or token: the gateway is off and runners get no MCP route (never a
  fallback to an unscoped credential).
- Missing, unknown, expired or revoked identity, an out-of-scope repository, a
  write tool, or an unreachable gateway: the call is denied or errors; nothing
  is retried with a broader identity.
- Denials must name a reason in the ledger; ledger and registry must never hold a
  credential.

## Operator runbook

- A failing identity case: confirm `integrations/mcp-gateway/.env` token and
  `OBOT_MCP_URL`, then the connect-URL steps in `integrations/mcp-gateway/README.md`.
- Obot restart: wait for `integrations/bazzite/obot/validate.sh`, then re-run the
  suite; identities must work again without re-issuing them.
- Suspected leak: search the ledger and traces for `ghs_`, `ghp_`, `github_pat_`
  and `Bearer`; the suite asserts none appear.

## Minimum supported versions

Obot `v0.27.0` (pinned in `integrations/bazzite/obot/env.example`), Caddy as
pinned there, PowerShell 7, Python 3.10, Node 20. Claude Code and Codex must
support `--strict-mcp-config` and `bearer_token_env_var` respectively.

## Not covered (explicit gaps)

These parts of the parent epic are not in this repository, so the suite does
not claim them; a gate is not passed by their absence:

- GitHub App installation-token minting, expiry and rotation against GitHub, and
  independent native `git`/`gh` paths.
- Executable-skill sync: content-hash mismatch, incomplete sync, rollback and
  malicious skill instructions.
- Live Obot restart, catalog failure, and correlation in the real Langfuse/OTel
  stack (the ledger correlation here is against the stand-in).
- Registration of Godot and non-Godot projects with Codex/Claude adapters in
  concurrent ephemeral worktrees.
