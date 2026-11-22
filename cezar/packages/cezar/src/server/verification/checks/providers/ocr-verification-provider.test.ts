import { describe, expect, it, vi } from 'vitest';
import { createOcrVerificationProviders } from './ocr-verification-provider.js';
import { OCR_PROVIDER_VERSION } from './ocr-adapter.js';

const sha = (char: string) => char.repeat(40);
const digest = (char: string) => `sha256:${char.repeat(64)}`;

describe('server-owned OCR provider registration', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(createOcrVerificationProviders({})).toEqual({});
  });

  it('uses the authenticated worker, exact revisions, and matching usage receipt when enabled', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/execute')) {
        const request = JSON.parse(String(init?.body)) as { argv: string[] };
        const stdout = request.argv[1] === 'version' ? `ocr ${OCR_PROVIDER_VERSION}` : JSON.stringify(request.argv.includes('--preview')
          ? { manifest: { schema_version: 'ocr.run-manifest/v1', operation: 'review', terminal_state: 'complete', run_id: 'session-1', input: { mode: 'range', resolved_base: sha('a'), resolved_head: sha('b') }, coverage: { selected: [{ path: 'src/a.ts' }], completed: [{ path: 'src/a.ts' }], reused: [], failed: [], waived: [] } } }
          : { session_id: 'session-1', summary: { total_tokens: 5 }, warnings: [], tool_calls: { failure: 0 }, manifest: { schema_version: 'ocr.run-manifest/v1', operation: 'review', terminal_state: 'complete', run_id: 'session-1', input: { mode: 'range', resolved_base: sha('a'), resolved_head: sha('b') }, coverage: { selected: [{ path: 'src/a.ts' }], completed: [{ path: 'src/a.ts' }], reused: [], failed: [], waived: [] } }, comments: [] });
        return new Response(JSON.stringify({ exitCode: 0, stdout }), { status: 200 });
      }
      return new Response(JSON.stringify({ tokens: 5, costUsd: 0.002, receiptId: 'receipt-1' }), { status: 200 });
    });
    const providers = createOcrVerificationProviders({
      CEZ_OCR_ENABLED: '1', CEZ_OCR_WORKER_URL: 'http://ocr-worker:8090', CEZ_OCR_WORKER_TOKEN: 'worker-token-0123456789abcdef012345',
      CEZ_OCR_GATEWAY_URL: 'http://litellm:4000/v1/chat/completions', CEZ_OCR_MODEL_ALIAS: 'factory-code',
      CEZ_OCR_RULE_PATH: '/opt/ocr/rules.json', CEZ_OCR_RULE_DIGEST: digest('c'), CEZ_OCR_POLICY_DIGEST: digest('d'),
    }, fetch);
    expect(Object.keys(providers)).toEqual(['ocr']);
    const plugin = providers.ocr!({ cwd: '/projects/repo/.ai/cezar/worktrees/task', baseSha: sha('a'), sourceSha: sha('b') } as never);
    const result = await plugin.run!({ signal: new AbortController().signal, sourceSha: sha('b'), definition: {} as never, scope: `${sha('a')}..${sha('b')}` });
    expect(result.ocrReviewEvidence).toMatchObject({ status: 'complete', baseSha: sha('a'), headSha: sha('b'), usageReceiptId: 'receipt-1', usageTokens: 5 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

