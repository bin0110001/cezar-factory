# MCP gateway client wiring

Cezar agent runs reach MCP servers (GitHub first) through the Obot gateway
([../bazzite/obot/README.md](../bazzite/obot/README.md)) instead of holding
per-server credentials. The Obot vMCP endpoint is the single MCP server the
runners see; which upstream servers and tools it exposes is decided in Obot.

## Configure

Copy `env.example` to `.env` here (gitignored, owner-only permissions) and set
`OBOT_MCP_TOKEN`. Or set `OBOT_MCP_URL` / `OBOT_MCP_TOKEN` (and optionally
`OBOT_MCP_CA_CERT`) in the Cezar host environment; the host env wins. Use
`CEZ_MCP_GATEWAY_ENV_FILE` to point at a different file. With no token the
gateway is off and runners behave as before.

## What each runner gets

Implemented in `cezar/packages/cezar/src/core/mcp-gateway.ts`.

| Runner | Mechanism |
| --- | --- |
| Claude | `--mcp-config` with `--strict-mcp-config` (only the gateway; user/project servers are ignored). The `Authorization` header references `${OBOT_MCP_TOKEN}` from the child env, so the token is not on the command line. |
| Codex | `config.mcp_servers.obot` on `thread/start` / `thread/resume`, with `bearer_token_env_var`. |
| Copilot (ACP) | HTTP entry in `session/new` / `session/load` `mcpServers`. |

Not yet routed: Junie, OpenCode, Cursor, Pi, and Codex/Copilot user-level MCP
servers (those runners don't have a strict mode wired). Move those servers into
Obot and remove them from the user configs to complete the migration.

## Adding servers

Register each server in Obot (the GitHub remote endpoint and its read-only
tool allow-list are described in the Obot README) and add it to the vMCP.
Clients need no change. Hindsight is still called directly by
`scripts/hindsight/`; register it in Obot before routing it through the gateway.
