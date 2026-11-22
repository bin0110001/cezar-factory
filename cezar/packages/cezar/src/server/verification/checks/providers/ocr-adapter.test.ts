import { describe, expect, it } from 'vitest';
import {
  buildOcrArgv, buildOcrEnvironment, isApprovedOcrGateway, ocrPlugin, OCR_PROVIDER_VERSION,
  type OcrPluginOptions,
} from './ocr-adapter.js';

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;

function manifest(over: Record<string, unknown> = {}) {
  return {
    schema_version: 'ocr.run-manifest/v1', operation: 'review', run_id: 'ocr-run-1',
    terminal_state: 'complete', input: { mode: 'range', resolved_base: FROM, resolved_head: TO },
    coverage: { selected: [{ path: 'src/example.ts' }], completed: [{ path: 'src/example.ts' }], reused: [], failed: [], waived: [] },
    ...over,
  };
}

function result(over: Record<string, unknown> = {}) {
  return {
    session_id: 'ocr-run-1', manifest: manifest(), summary: { total_tokens: 37 }, warnings: [], tool_calls: { failure: 0 },
    comments: [{ path: 'src/example.ts', start_line: 4, end_line: 4, severity: 'high', content: 'Handle the missing null case.', suggestion_code: 'if (value == null) return;' }],
    ...over,
  };
}

function options(over: Partial<OcrPluginOptions> = {}): OcrPluginOptions {
  return {
    repoPath: '/workspace/repo', fromSha: FROM, toSha: TO, gatewayUrl: 'http://litellm:4000', gatewayToken: 'secret-token', modelAlias: 'reviewer',
    budget: { maxTokens: 100, concurrency: 2, timeoutMinutes: 10 }, policyDigest: DIGEST, rulePath: '/workspace/rules/ocr.yaml', ruleDigest: DIGEST,
    readUsage: async () => ({ tokens: 37, costUsd: 0.01, receiptId: 'receipt-1' }),
    exec: async (argv) => ({ exitCode: 0, stdout: argv[1] === 'version' ? `ocr ${OCR_PROVIDER_VERSION}` : JSON.stringify(argv.includes('--preview') ? { manifest: manifest(), comments: [] } : result()) }),
    ...over,
  };
}

describe('OCR provider adapter', () => {
  it('pins immutable range, model, rule and explicit bounded invocation', () => {
    const o = options();
    expect(buildOcrArgv(o, 'preview')).toEqual([
      'ocr', 'review', '--repo', o.repoPath, '--from', FROM, '--to', TO, '--format', 'json', '--audience', 'agent',
      '--model', 'reviewer', '--concurrency', '2', '--timeout', '10', '--max-tokens-budget', '100', '--rule', o.rulePath, '--preview',
    ]);
    expect(buildOcrEnvironment(o)).toEqual({ OCR_LLM_URL: o.gatewayUrl, OCR_LLM_TOKEN: o.gatewayToken, OCR_LLM_MODEL: o.modelAlias, OCR_LLM_PROTOCOL: 'openai' });
    expect(isApprovedOcrGateway('https://reviewer.example')).toBe(false);
  });

  it('keeps valid claims and their reviewer session when coverage and usage are complete', async () => {
    const calls: string[][] = [];
    const output = await ocrPlugin(options({ exec: async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: argv[1] === 'version' ? 'ocr v1.14.0' : JSON.stringify(argv.includes('--preview') ? { manifest: manifest() } : result()) };
    } })).run({ signal: new AbortController().signal, sourceSha: TO, definition: {} as never, scope: 'diff' });
    expect(calls.map((argv) => argv[1])).toEqual(['version', 'review', 'review']);
    expect(calls[1]).toContain('--preview');
    expect(output.unknown).toBeUndefined();
    expect(output.document).toMatchObject({ findings: [{ id: expect.stringMatching(/^ocr-/), path: 'src/example.ts', line: 4, reviewerSessionId: 'ocr-run-1', suggestion: 'if (value == null) return;' }] });
    expect(output.inputsDigest).toMatch(/^sha256:/);
  });

  it('preserves findings but marks partial coverage unknown even when CLI exits zero', async () => {
    const partial = result({ manifest: manifest({ terminal_state: 'partial', coverage: { selected: [{ path: 'src/example.ts' }], completed: [], reused: [], failed: [{ path: 'src/example.ts' }], waived: [] } }) });
    const output = await ocrPlugin(options({ exec: async (argv) => ({ exitCode: 0, stdout: argv[1] === 'version' ? 'ocr v1.14.0' : JSON.stringify(argv.includes('--preview') ? { manifest: manifest() } : partial) }) })).run({ signal: new AbortController().signal, sourceSha: TO, definition: {} as never, scope: 'diff' });
    expect(output.unknown).toBeTruthy();
    expect(output.document).toMatchObject({ findings: [{ path: 'src/example.ts' }] });
  });

  it('distinguishes a complete clean review and fails closed when the manifest excludes work', async () => {
    const clean = result({ comments: [] });
    const excluded = result({ manifest: manifest({ coverage: { selected: [{ path: 'src/example.ts' }], completed: [{ path: 'src/example.ts' }], reused: [], failed: [], waived: [], excluded: [{ path: 'src/hidden.ts' }] } }) });
    const run = (doc: unknown) => ocrPlugin(options({ exec: async (argv) => ({ exitCode: 0, stdout: argv[1] === 'version' ? 'ocr v1.14.0' : JSON.stringify(argv.includes('--preview') ? { manifest: manifest() } : doc) }) })).run({ signal: new AbortController().signal, sourceSha: TO, definition: {} as never, scope: 'diff' });
    const cleanOutput = await run(clean);
    expect(cleanOutput.document).toMatchObject({ findings: [] });
    expect(cleanOutput.unknown).toBeUndefined();
    expect((await run(excluded)).unknown).toBeTruthy();
  });

  it('redacts the explicit gateway token from comments and rejects paths outside the checkout', async () => {
    const leaked = result({ comments: [
      { path: 'src/example.ts', start_line: 4, content: 'Credential secret-token was committed.' },
      { path: '../outside.txt', start_line: 1, content: 'Unexpected outside path.' },
    ] });
    const output = await ocrPlugin(options({ exec: async (argv) => ({ exitCode: 0, stdout: argv[1] === 'version' ? 'ocr v1.14.0' : JSON.stringify(argv.includes('--preview') ? { manifest: manifest() } : leaked) }) })).run({ signal: new AbortController().signal, sourceSha: TO, definition: {} as never, scope: 'diff' });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('outside.txt');
    expect(output.unknown).toBeTruthy();
  });

  it('rejects changed preview selection, over-budget usage and revision mismatch', async () => {
    const changedSelection = result({ manifest: manifest({ coverage: { selected: [{ path: 'src/other.ts' }], completed: [{ path: 'src/other.ts' }], reused: [], failed: [], waived: [] } }) });
    const makeExec = (review: unknown) => async (argv: string[]) => ({ exitCode: 0, stdout: argv[1] === 'version' ? 'ocr v1.14.0' : JSON.stringify(argv.includes('--preview') ? { manifest: manifest() } : review) });
    const run = (review: unknown, usage: OcrPluginOptions['readUsage'] = async () => ({ tokens: 37, costUsd: 0.01, receiptId: 'r' })) => ocrPlugin(options({ exec: makeExec(review), readUsage: usage })).run({ signal: new AbortController().signal, sourceSha: TO, definition: {} as never, scope: 'diff' });
    expect((await run(changedSelection)).unknown).toBeTruthy();
    expect((await run(result(), async () => ({ tokens: 101, costUsd: 0.01, receiptId: 'r' }))).unknown).toBeTruthy();
    expect((await run(result({ manifest: manifest({ input: { mode: 'range', resolved_base: FROM, resolved_head: 'd'.repeat(40) } }) }))).unknown).toMatch(/revision/);
  });

  it('does not treat duplicate completed paths as full manifest coverage', async () => {
    const coverage = { selected: [{ path: 'src/example.ts' }, { path: 'src/second.ts' }], completed: [{ path: 'src/example.ts' }, { path: 'src/example.ts' }], reused: [], failed: [], waived: [] };
    const duplicated = result({ manifest: manifest({ coverage }) });
    const preview = manifest({ coverage: { ...coverage, completed: [], failed: [], waived: [] } });
    const output = await ocrPlugin(options({ exec: async (argv) => ({ exitCode: 0, stdout: argv[1] === 'version' ? 'ocr v1.14.0' : JSON.stringify(argv.includes('--preview') ? { manifest: preview } : duplicated) }) })).run({ signal: new AbortController().signal, sourceSha: TO, definition: {} as never, scope: 'diff' });
    expect(output.unknown).toBeTruthy();
  });

  it('returns not-applicable only when preview finds no supported changed files', async () => {
    const none = manifest({ coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] } });
    const output = await ocrPlugin(options({ exec: async (argv) => ({ exitCode: 0, stdout: argv[1] === 'version' ? 'ocr v1.14.0' : JSON.stringify({ manifest: none }) }) })).run({ signal: new AbortController().signal, sourceSha: TO, definition: {} as never, scope: 'diff' });
    expect(output.notApplicable).toBe('no supported changed files');
  });

  it('does not expose credentials in its result when the provider fails', async () => {
    const output = await ocrPlugin(options({ exec: async (argv) => ({ exitCode: argv[1] === 'version' ? 1 : 1, stdout: 'secret-token' }) })).run({ signal: new AbortController().signal, sourceSha: TO, definition: {} as never, scope: 'diff' });
    expect(JSON.stringify(output)).not.toContain('secret-token');
    expect(output.unknown).toMatch(/probe failed/);
  });
});
