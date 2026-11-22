import { describe, expect, it, vi } from 'vitest';
import { OcrWorkerClient } from './ocr-worker-client.js';

describe('OcrWorkerClient', () => {
  it('uses the authenticated worker API and returns a bounded execution result', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ exitCode: 0, stdout: 'ocr 1.14.1' }), { status: 200 }));
    const client = new OcrWorkerClient({ baseUrl: 'http://ocr-worker:8090/', token: 'worker-secret-0123456789abcdef012345', fetch });
    const result = await client.exec(['ocr', 'version'], { HOME: '/run/factory/ocr-home', OCR_LLM_TOKEN: 'must-not-cross-RPC' }, new AbortController().signal);
    expect(result).toEqual({ exitCode: 0, stdout: 'ocr 1.14.1' });
    expect(fetch).toHaveBeenCalledWith(new URL('http://ocr-worker:8090/v1/execute'), expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer worker-secret-0123456789abcdef012345' }),
      body: JSON.stringify({ argv: ['ocr', 'version'], env: { HOME: '/run/factory/ocr-home' } }),
    }));
  });

  it('reads only a well-formed usage receipt and treats a missing one as unavailable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: 37, costUsd: 0.01, receiptId: 'receipt-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const client = new OcrWorkerClient({ baseUrl: 'https://scanner.example.test', token: 'worker-secret-0123456789abcdef012345', fetch });
    expect(await client.readUsage('ocr-session:1')).toEqual({ tokens: 37, costUsd: 0.01, receiptId: 'receipt-1' });
    expect(await client.readUsage('missing')).toBeUndefined();
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('https://scanner.example.test/v1/usage/ocr-session%3A1'));
  });

  it('fails closed on insecure remote URLs, malformed receipts, and oversized output', async () => {
    expect(() => new OcrWorkerClient({ baseUrl: 'http://scanner.example.test', token: 'worker-secret-0123456789abcdef012345' })).toThrow(/HTTPS/);
    const malformed = new OcrWorkerClient({
      baseUrl: 'http://ocr-worker:8090', token: 'worker-secret-0123456789abcdef012345',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"tokens":1}', { status: 200 })),
    });
    await expect(malformed.readUsage('session')).rejects.toThrow();
    const oversized = new OcrWorkerClient({
      baseUrl: 'http://ocr-worker:8090', token: 'worker-secret-0123456789abcdef012345',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 })),
    });
    await expect(oversized.exec(['ocr', 'version'], {}, new AbortController().signal)).rejects.toThrow(/2 MiB/);
  });
});

