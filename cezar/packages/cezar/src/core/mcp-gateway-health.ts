import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { McpGatewayCheckResponse } from '@open-mercato/cezar-contract';
import type { McpGateway } from './mcp-gateway.ts';

const PROBE_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type InitializeReply = {
  jsonrpc?: unknown;
  result?: {
    protocolVersion?: unknown;
    serverInfo?: { name?: unknown; version?: unknown };
  };
};

/** A bounded, read-only MCP initialize probe. It deliberately never asks for tools/list. */
export async function checkMcpGateway(
  gateway: McpGateway | null,
  now: () => Date = () => new Date(),
  requestImpl: typeof httpsRequest = httpsRequest,
): Promise<McpGatewayCheckResponse> {
  const checkedAt = now().toISOString();
  if (!gateway) return { status: 'unconfigured', checkedAt, errorCategory: 'configuration' };

  let endpoint: URL;
  try {
    endpoint = new URL(gateway.url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('invalid endpoint');
  } catch {
    return { status: 'unhealthy', checkedAt, errorCategory: 'configuration' };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: McpGatewayCheckResponse) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, checkedAt });
    };

    let ca: Buffer | undefined;
    if (gateway.caCertPath) {
      try { ca = readFileSync(gateway.caCertPath); }
      catch { finish({ status: 'unhealthy', checkedAt, errorCategory: 'configuration' }); return; }
    }

    let body = '';
    const req = requestImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      ...(ca ? { ca } : {}),
      timeout: PROBE_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        let errorCategory: 'authentication' | 'forbidden' | 'unavailable' | 'invalid-response';
        if (res.statusCode === 401) errorCategory = 'authentication';
        else if (res.statusCode === 403) errorCategory = 'forbidden';
        else if (res.statusCode && res.statusCode >= 500) errorCategory = 'unavailable';
        else errorCategory = 'invalid-response';
        finish({ status: 'unhealthy', checkedAt, errorCategory });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
          req.destroy();
          finish({ status: 'unhealthy', checkedAt, errorCategory: 'invalid-response' });
        }
      });
      res.on('end', () => {
        let reply: InitializeReply;
        try {
          const compact = body.trim();
          const json = compact.startsWith('{')
            ? compact
            : compact.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          reply = JSON.parse(json) as InitializeReply;
        }
        catch { finish({ status: 'unhealthy', checkedAt, errorCategory: 'invalid-response' }); return; }
        const info = reply.jsonrpc === '2.0' && reply.result?.serverInfo;
        if (!info || typeof info.name !== 'string' || typeof info.version !== 'string') {
          finish({ status: 'unhealthy', checkedAt, errorCategory: 'invalid-response' });
          return;
        }
        finish({
          status: 'healthy',
          checkedAt,
          serverName: info.name.slice(0, 80),
          serverVersion: info.version.slice(0, 80),
          ...(typeof reply.result?.protocolVersion === 'string'
            ? { protocolVersion: reply.result.protocolVersion.slice(0, 40) }
            : {}),
        });
      });
    });

    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (error: NodeJS.ErrnoException) => {
      const errorCategory = error.code === 'CERT_HAS_EXPIRED' || error.code?.startsWith('ERR_TLS') || error.code?.startsWith('CERT_')
        ? 'tls'
        : error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'EHOSTUNREACH'
          ? 'unavailable'
          : 'invalid-response';
      finish({ status: 'unhealthy', checkedAt, errorCategory });
    });
    req.end(JSON.stringify({
      jsonrpc: '2.0',
      id: 'cezar-health-check',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'cezar-health-check', version: '1' },
      },
    }));
  });
}

/** Return only safe endpoint metadata; URL path and credentials never leave the server. */
export function mcpGatewayStatus(gateway: McpGateway | null) {
  let endpointHost: string | null = null;
  let endpointValid = false;
  if (gateway) {
    try {
      const url = new URL(gateway.url);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        endpointHost = url.host;
        endpointValid = true;
      }
    } catch { /* invalid configuration is reported without echoing it */ }
  }
  return { configured: gateway !== null, endpointHost, endpointValid } as const;
}
