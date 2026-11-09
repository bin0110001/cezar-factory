/**
 * Obot MCP gateway wiring: every agent backend reaches MCP servers (GitHub first) through the
 * gateway's single streamable-HTTP endpoint instead of holding per-server credentials.
 *
 * Settings come from the host env (`OBOT_MCP_URL`, `OBOT_MCP_TOKEN`, optional `OBOT_MCP_CA_CERT`)
 * or, when absent, from the gitignored `integrations/mcp-gateway/.env` (override the path with
 * `CEZ_MCP_GATEWAY_ENV_FILE`). With no token the gateway is simply off and runners behave as before.
 *
 * The token never goes on a command line: Claude and Codex read it from the child env by name,
 * and ACP carries it in-protocol (stdin), not argv.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATEWAY_SERVER_NAME = 'obot';
const TOKEN_ENV = 'OBOT_MCP_TOKEN';

export interface McpGateway {
  url: string;
  token: string;
  /** Public root certificate for the gateway's internal CA (Caddy `tls internal`), if it needs one. */
  caCertPath?: string;
}

function defaultEnvFile(): string {
  // src/core -> cezar -> packages -> cezar -> repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../integrations/mcp-gateway/.env');
}

/** Minimal dotenv parse: `KEY=value` lines, `#` comments, optional surrounding quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function resolveMcpGateway(
  env: NodeJS.ProcessEnv = process.env,
  readText: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): McpGateway | null {
  let file: Record<string, string> = {};
  try {
    file = parseEnvFile(readText(env.CEZ_MCP_GATEWAY_ENV_FILE || defaultEnvFile()));
  } catch {
    // No file is the normal "gateway not configured" state.
  }
  const pick = (name: string): string => (env[name] || file[name] || '').trim();
  const url = pick('OBOT_MCP_URL');
  const token = pick(TOKEN_ENV);
  if (!url || !token) return null;
  const caCertPath = pick('OBOT_MCP_CA_CERT');
  return { url, token, ...(caCertPath ? { caCertPath } : {}) };
}

/** Per-run child env: the token (referenced by name below) and the CA trust for the gateway. */
export function gatewayEnv(gw: McpGateway | null): Record<string, string> {
  if (!gw) return {};
  const out: Record<string, string> = { [TOKEN_ENV]: gw.token };
  if (gw.caCertPath) {
    out.NODE_EXTRA_CA_CERTS = gw.caCertPath; // Claude / Copilot (Node), additive to system roots
    out.CODEX_CA_CERTIFICATE = gw.caCertPath; // Codex (Rust)
  }
  return out;
}

/** `claude --mcp-config` args. Strict, so no server bypasses the gateway. The header expands `${OBOT_MCP_TOKEN}` from the child env. */
export function claudeMcpArgs(gw: McpGateway | null): string[] {
  if (!gw) return [];
  const config = {
    mcpServers: {
      [GATEWAY_SERVER_NAME]: {
        type: 'http',
        url: gw.url,
        headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
      },
    },
  };
  return ['--mcp-config', JSON.stringify(config), '--strict-mcp-config'];
}

/** Codex `thread/start` / `thread/resume` `config` override. */
export function codexMcpConfig(gw: McpGateway | null): Record<string, unknown> | undefined {
  if (!gw) return undefined;
  return { mcp_servers: { [GATEWAY_SERVER_NAME]: { url: gw.url, bearer_token_env_var: TOKEN_ENV } } };
}

/** ACP `session/new` / `session/load` `mcpServers` (HTTP transport). */
export function acpMcpServers(gw: McpGateway | null): Array<Record<string, unknown>> {
  if (!gw) return [];
  return [
    {
      type: 'http',
      name: GATEWAY_SERVER_NAME,
      url: gw.url,
      headers: [{ name: 'Authorization', value: `Bearer ${gw.token}` }],
    },
  ];
}
