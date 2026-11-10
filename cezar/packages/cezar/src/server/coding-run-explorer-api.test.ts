import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codingRunExplorerResponseSchema, reliabilityAnalyticsResponseSchema, type CodingRunRecord } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createCodingRun } from '../workspace/lifecycle.ts';
import { appendCodingRunEvent } from '../workspace/lifecycle.ts';
import { storeCodingRunArtifact } from '../workspace/coding-run-artifacts.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('coding run explorer API', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-run-explorer-'));
    home = join(root, 'home');
    vi.stubEnv('CEZ_HOME', home);
    vi.stubEnv('CEZ_DRY_RUN', '1');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    execFileSync('git', ['init', '-q', '-b', 'dev'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  });
  afterEach(() => { store.flush(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

  const app = () => createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
  const runRecord = (runId: string, number = 42): CodingRunRecord => ({
    schemaVersion: 1, runId, projectId: 'default', correlationId: `correlation-${runId}`,
    source: { number, revision: { availability: 'unknown' } }, baseSha: { availability: 'unknown' },
    pullRequest: { availability: 'unknown' }, worker: { availability: 'unavailable', reasonCode: 'worker-not-set' },
    agent: { availability: 'available', value: { provider: 'codex', adapterId: 'codex-cli' } },
    model: { availability: 'unknown' }, promptSha256: { availability: 'unknown' }, skillSha256: [],
    status: 'running', startedAt: '2026-11-10T08:00:00.000Z',
  });

  it('paginates a stable issue-scoped summary and reports trace availability without failing', async () => {
    await createCodingRun({ record: runRecord('run-a'), cwd: root, home });
    await createCodingRun({ record: runRecord('run-b'), cwd: root, home });
    const instance = app();
    const first = codingRunExplorerResponseSchema.parse(await (await apiRequest(instance, '/api/v1/p/default/tracker/42/run-explorer?limit=1')).json());
    expect(first).toMatchObject({ issueNumber: 42, complete: false, runs: [{ runId: 'run-b', status: 'running', integrity: 'valid', agent: { availability: 'available' }, trace: { availability: 'unavailable' } }] });
    expect(first.nextCursor).toBeTruthy();
    const second = codingRunExplorerResponseSchema.parse(await (await apiRequest(instance, `/api/v1/p/default/tracker/42/run-explorer?limit=1&cursor=${first.nextCursor}`)).json());
    expect(second).toMatchObject({ complete: true, runs: [{ runId: 'run-a' }] });
    expect((await apiRequest(instance, '/api/v1/p/default/tracker/43/run-explorer')).status).toBe(200);
    expect(await (await apiRequest(instance, '/api/v1/p/default/tracker/43/run-explorer')).json()).toMatchObject({ runs: [], issueNumber: 43 });
    expect((await apiRequest(instance, '/api/v1/p/default/tracker/42/run-explorer?cursor=bad')).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/p/unknown/tracker/42/run-explorer')).status).toBe(404);
  });

  it('serves a bounded reliability analytics response and rejects unsupported windows', async () => {
    const instance = app();
    const response = await apiRequest(instance, '/api/v1/p/default/verification/analytics?windowDays=30');
    expect(response.status).toBe(200);
    const analytics = reliabilityAnalyticsResponseSchema.parse(await response.json());
    expect(analytics).toMatchObject({ windowDays: 30, summary: { validationRuns: 0, pullRequests: { tracked: 0, unknown: 0 } }, coverage: { truncated: false } });
    expect(analytics.trends).toHaveLength(30);
    expect((await apiRequest(instance, '/api/v1/p/default/verification/analytics?windowDays=14')).status).toBe(400);
  });

  it('serves only unexpired evidence attached to the requested issue and run', async () => {
    await createCodingRun({ record: runRecord('run-artifact'), cwd: root, home });
    const evidence = await storeCodingRunArtifact({ content: Buffer.from('redacted test receipt'), mediaType: 'text/plain', home });
    await appendCodingRunEvent({ runId: 'run-artifact', type: 'context.prepared', cwd: root, home, evidence: [evidence] });
    const instance = app();
    const listed = codingRunExplorerResponseSchema.parse(await (await apiRequest(instance, '/api/v1/p/default/tracker/42/run-explorer')).json());
    const digest = listed.runs[0]?.evidence[0]?.sha256;
    expect(digest).toBe(evidence.sha256);
    const path = `/api/v1/p/default/tracker/42/run-explorer/run-artifact/${digest}`;
    const downloaded = await apiRequest(instance, path);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('redacted test receipt');
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await apiRequest(instance, `/api/v1/p/default/tracker/43/run-explorer/run-artifact/${digest}`)).status).toBe(404);
    expect((await apiRequest(instance, `/api/v1/p/default/tracker/42/run-explorer/run-artifact/${'a'.repeat(64)}`)).status).toBe(404);
  });

  it('builds a project-scoped Langfuse link without exposing credentials', async () => {
    vi.stubEnv('LANGFUSE_HOST', 'https://langfuse.example/base');
    vi.stubEnv('LANGFUSE_PROJECT_ID', 'project-a');
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-private-check');
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-private-check');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'OK' })));
    await createCodingRun({ record: runRecord('run-trace'), cwd: root, home });
    const response = await apiRequest(app(), '/api/v1/p/default/tracker/42/run-explorer');
    const body = codingRunExplorerResponseSchema.parse(await response.json());
    expect(body.runs[0]?.trace).toMatchObject({ availability: 'available', url: expect.stringMatching(/^https:\/\/langfuse\.example\/base\/project\/project-a\/traces\/[a-f0-9]{32}$/) });
    expect(JSON.stringify(body)).not.toContain('sk-private-check');
    expect(JSON.stringify(body)).not.toContain('pk-private-check');
  });

  it('marks trace links unavailable when the configured Langfuse health endpoint is offline', async () => {
    vi.stubEnv('LANGFUSE_HOST', 'http://127.0.0.1:1');
    vi.stubEnv('LANGFUSE_PROJECT_ID', 'project-a');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await createCodingRun({ record: runRecord('run-offline'), cwd: root, home });
    const body = codingRunExplorerResponseSchema.parse(await (await apiRequest(app(), '/api/v1/p/default/tracker/42/run-explorer')).json());
    expect(body.runs[0]?.trace).toMatchObject({ availability: 'unavailable', reason: expect.stringMatching(/offline|health check/i) });
  });
});
