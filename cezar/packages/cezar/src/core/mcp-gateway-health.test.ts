import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { checkMcpGateway, mcpGatewayStatus } from './mcp-gateway-health.ts';

describe('MCP gateway diagnostics (#171)', () => {
  it('returns configured state with only the HTTPS hostname', () => {
    const result = mcpGatewayStatus({
      url: 'https://gateway.example:8443/mcp-connect/private-vmcp-id',
      token: 'never-return-this-token',
    });
    expect(result).toEqual({ configured: true, endpointHost: 'gateway.example:8443', endpointValid: true });
    expect(JSON.stringify(result)).not.toContain('private-vmcp-id');
    expect(JSON.stringify(result)).not.toContain('never-return-this-token');
  });

  it('does not echo malformed endpoint configuration', () => {
    const result = mcpGatewayStatus({ url: 'not a url with a secret', token: 'secret' });
    expect(result).toEqual({ configured: true, endpointHost: null, endpointValid: false });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('reports an unconfigured gateway without attempting a network request', async () => {
    const result = await checkMcpGateway(null, () => new Date('2026-11-22T12:00:00.000Z'));
    expect(result).toEqual({
      status: 'unconfigured',
      checkedAt: '2026-11-22T12:00:00.000Z',
      errorCategory: 'configuration',
    });
  });

  it('rejects non-HTTPS probe targets without exposing the configured URL', async () => {
    const result = await checkMcpGateway({ url: 'http://127.0.0.1:8080/private-path', token: 'secret' });
    expect(result.status).toBe('unhealthy');
    expect(result.errorCategory).toBe('configuration');
    expect(JSON.stringify(result)).not.toContain('private-path');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('uses only MCP initialize and returns bounded server metadata without the URL or token', async () => {
    const request = ((_url: URL, options: { headers: Record<string, string> }, callback: (response: unknown) => void) => {
      expect(options.headers.Authorization).toBe('Bearer probe-secret');
      const req = new EventEmitter() as EventEmitter & { end: (body: string) => void; destroy: () => void };
      req.end = (body) => {
        const sent = JSON.parse(body) as { method: string };
        expect(sent.method).toBe('initialize');
        const response = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: () => void };
        response.statusCode = 200;
        response.setEncoding = () => undefined;
        queueMicrotask(() => {
          callback(response);
          response.emit('data', JSON.stringify({
            jsonrpc: '2.0', result: { protocolVersion: '2025-03-26', serverInfo: { name: 'obot', version: '1.2.3' } },
          }));
          response.emit('end');
        });
      };
      req.destroy = () => undefined;
      return req;
    }) as unknown as typeof import('node:https').request;

    const result = await checkMcpGateway({
      url: 'https://gateway.example:8443/mcp-connect/private-id', token: 'probe-secret',
    }, () => new Date('2026-11-22T12:00:00.000Z'), request);
    expect(result).toEqual({
      status: 'healthy', checkedAt: '2026-11-22T12:00:00.000Z', serverName: 'obot',
      serverVersion: '1.2.3', protocolVersion: '2025-03-26',
    });
    expect(JSON.stringify(result)).not.toContain('private-id');
    expect(JSON.stringify(result)).not.toContain('probe-secret');
  });
});
