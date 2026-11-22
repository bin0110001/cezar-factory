import { z } from 'zod';
import type { OcrExec, OcrExecResult, OcrUsage } from './ocr-adapter.js';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const workerExecResponseSchema = z.object({
  exitCode: z.number().int().min(-255).max(255),
  stdout: z.string(),
}).strict();
const workerUsageResponseSchema = z.object({
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  receiptId: z.string().min(1).max(128),
}).strict();

export interface OcrWorkerClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

function normalizedBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OCR worker URL must be an HTTP(S) origin without credentials, query, or fragment');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1', 'ocr-worker', 'host.containers.internal'].includes(url.hostname.toLowerCase()) && !url.hostname.endsWith('.local')) {
    throw new Error('OCR worker must use HTTPS unless it is addressed on the private local service network');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
  return url;
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_OUTPUT_BYTES) throw new Error('OCR worker response exceeded the 2 MiB limit');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('OCR worker response exceeded the 2 MiB limit');
  return text;
}

/** Authenticated, bounded client for the separately isolated OCR worker service. */
export class OcrWorkerClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OcrWorkerClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    if (options.token.trim().length < 32) throw new Error('OCR worker bearer token must contain at least 32 characters');
    this.fetchImpl = options.fetch ?? fetch;
  }

  readonly exec: OcrExec = async (argv, env, signal): Promise<OcrExecResult> => {
    // The isolated worker owns the LiteLLM secret. Never send the adapter's placeholder/token over RPC.
    const workerEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'OCR_LLM_TOKEN'));
    const response = await this.fetchImpl(new URL('v1/execute', this.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ argv, env: workerEnv }),
      signal,
    });
    const text = await readBounded(response);
    if (!response.ok) throw new Error(`OCR worker execution failed with HTTP ${response.status}`);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('OCR worker returned invalid execution JSON'); }
    return workerExecResponseSchema.parse(parsed);
  };

  async readUsage(sessionId: string | undefined): Promise<OcrUsage | undefined> {
    if (!sessionId || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) return undefined;
    const response = await this.fetchImpl(new URL(`v1/usage/${encodeURIComponent(sessionId)}`, this.baseUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.options.token}`, accept: 'application/json' },
    });
    if (response.status === 404) return undefined;
    const text = await readBounded(response);
    if (!response.ok) throw new Error(`OCR worker usage lookup failed with HTTP ${response.status}`);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('OCR worker returned invalid usage JSON'); }
    return workerUsageResponseSchema.parse(parsed);
  }
}

