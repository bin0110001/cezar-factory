import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from './claude-cli-runner.ts';
import {
  acpMcpServers,
  claudeMcpArgs,
  codexMcpConfig,
  gatewayEnv,
  parseEnvFile,
  resolveMcpGateway,
  type McpGateway,
} from './mcp-gateway.ts';

const gw: McpGateway = { url: 'https://obot.example:8443/mcp-servers', token: 's3cret', caCertPath: '/ca/root.crt' };
const noFile = (): string => {
  throw new Error('ENOENT');
};

describe('resolveMcpGateway', () => {
  it('is off without a token', () => {
    expect(resolveMcpGateway({ OBOT_MCP_URL: 'https://x/mcp' }, noFile)).toBeNull();
    expect(resolveMcpGateway({}, () => 'OBOT_MCP_URL=https://x/mcp\nOBOT_MCP_TOKEN=\n')).toBeNull();
  });

  it('reads the gitignored env file, with host env taking precedence', () => {
    const file = '# c\nOBOT_MCP_URL="https://file/mcp"\nOBOT_MCP_TOKEN=filetok\nOBOT_MCP_CA_CERT=/ca.crt\n';
    expect(resolveMcpGateway({}, () => file)).toEqual({ url: 'https://file/mcp', token: 'filetok', caCertPath: '/ca.crt' });
    expect(resolveMcpGateway({ OBOT_MCP_TOKEN: 'envtok' }, () => file)?.token).toBe('envtok');
  });

  it('parses dotenv text', () => {
    expect(parseEnvFile('A=1\r\n#x\n\nB = "two"\nbad\n')).toEqual({ A: '1', B: 'two' });
  });
});

describe('gateway config builders', () => {
  it('emit nothing when the gateway is off', () => {
    expect(gatewayEnv(null)).toEqual({});
    expect(claudeMcpArgs(null)).toEqual([]);
    expect(codexMcpConfig(null)).toBeUndefined();
    expect(acpMcpServers(null)).toEqual([]);
  });

  it('keeps the token out of Claude argv', () => {
    const args = claudeMcpArgs(gw);
    expect(args).toContain('--strict-mcp-config');
    expect(args.join(' ')).not.toContain('s3cret');
    expect(JSON.parse(args[1]!).mcpServers.obot.headers.Authorization).toBe('Bearer ${OBOT_MCP_TOKEN}');
    expect(gatewayEnv(gw)).toMatchObject({ OBOT_MCP_TOKEN: 's3cret', NODE_EXTRA_CA_CERTS: '/ca/root.crt' });
  });

  it('wires Codex by env var name and ACP in-protocol', () => {
    expect(codexMcpConfig(gw)).toEqual({
      mcp_servers: { obot: { url: gw.url, bearer_token_env_var: 'OBOT_MCP_TOKEN' } },
    });
    expect(acpMcpServers(gw)[0]).toMatchObject({ type: 'http', name: 'obot', url: gw.url });
  });

  it('buildClaudeArgs appends the gateway config only when given one', () => {
    const spec = { cwd: '/repo', prompt: 'p' } as Parameters<typeof buildClaudeArgs>[0];
    expect(buildClaudeArgs(spec, {})).not.toContain('--mcp-config');
    expect(buildClaudeArgs(spec, {}, gw)).toContain('--mcp-config');
  });
});
