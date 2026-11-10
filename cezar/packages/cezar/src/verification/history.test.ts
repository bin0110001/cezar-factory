import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verificationRunSchema, type VerificationRun } from '@open-mercato/cezar-contract';
import type { ProjectContext } from '../server/project-context.ts';
import { queryVerificationHistory, readVerificationArtifact } from './history.ts';

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cezar verification history '));
  roots.push(root);
  const records = [
    record('verify-2', '2026-11-09T10:00:00.000Z', 'failed', fingerprint),
    record('verify-1', '2026-11-08T10:00:00.000Z', 'failed', fingerprint),
  ];
  const owners = records.map(({ id, result, selection }) => ({
    id, worktree: false,
    ...(id === 'verify-2' ? { referencedIssueUrl: 'https://github.com/acme/project/issues/42' } : {}),
    result,
    selection,
    events: [{ seq: 1, ts: result.finishedAt, type: 'verification-result', result, selection, suite: 'quick' }],
  }));
  const context = {
    root,
    store: {
      listRuns: () => owners,
      readEvents: (id: string) => owners.find((owner) => owner.id === id)?.events ?? [],
      getRun: (id: string) => owners.find((owner) => owner.id === id),
    },
  } as unknown as ProjectContext;
  return { root, records, owners, context };
}

function record(id: string, startedAt: string, status: 'failed' | 'passed', findingFingerprint?: string) {
  const failed = status === 'failed';
  const result: VerificationRun = verificationRunSchema.parse({
    resultVersion: 1,
    verificationId: id,
    cezarRunId: id,
    projectId: 'project',
    worktreeId: 'worktree',
    commitSha: '1'.repeat(40),
    manifestSha256: '2'.repeat(64),
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
    toolVersions: {},
    environment: { platform: 'linux', API_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' },
    status,
    semanticExitCode: failed ? 1 : 0,
    coverage: { selected: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0, unknown: 0 },
    checks: [{
      checkId: 'unit', required: true, attempt: 1, status,
      rawExitCode: failed ? 1 : 0, semanticExitCode: failed ? 1 : 0, durationMs: failed ? 120 : 80,
      outputPreview: failed ? 'test failed' : 'passed', outputTruncated: false,
      diagnostics: failed ? [{ code: 'assertion', severity: 'error', message: 'expected true' }] : [],
      metrics: [{ name: 'cases', value: 4, unit: 'tests', samples: 1, method: 'count' }],
      coverage: { selected: 1, passed: failed ? 0 : 1, skipped: 0 },
      ...(findingFingerprint && failed ? { findingFingerprint } : {}),
      artifacts: [],
    }],
    artifacts: [],
  });
  return {
    id,
    result,
    selection: {
      suite: 'quick',
      selected: [{ testId: 'unit', reason: 'Included in suite quick.' }],
      deferred: [{ testId: 'browser', reason: 'Not included in suite quick.' }],
    },
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('verification history query', () => {
  it('uses the shared v1 envelope with per-check duration and metrics and stable pagination', async () => {
    const { context } = await fixture();
    const first = await queryVerificationHistory(context, { kind: 'runs', pageSize: 1 });
    expect(first).toMatchObject({ schemaVersion: 1, kind: 'runs', page: { returned: 1, hasMore: true } });
    if (!('kind' in first) || first.kind !== 'runs') throw new Error('expected run query page');
    expect(first.items[0]?.checks?.[0]).toMatchObject({ checkId: 'unit', durationMs: 120, metrics: [{ name: 'cases', value: 4 }] });
    expect(first.items[0]).toMatchObject({ projectId: 'project', cezarRunId: 'verify-2', githubIssueUrl: 'https://github.com/acme/project/issues/42', environment: { platform: 'linux', API_TOKEN: '[REDACTED]' }, coverage: { selected: 1, failed: 1 } });
    const nextCursor = first.page.nextCursor;
    expect(nextCursor).toBeTruthy();
    const second = await queryVerificationHistory(context, { kind: 'runs', pageSize: 1, cursor: nextCursor! });
    expect(second).toMatchObject({ kind: 'runs', items: [{ id: 'verify-1' }], page: { hasMore: false } });
  });

  it('returns selection reasons and groups repeated findings as known episodes', async () => {
    const { context } = await fixture();
    const selected = await queryVerificationHistory(context, { kind: 'selected', runId: 'verify-2', pageSize: 10 });
    expect(selected).toMatchObject({ kind: 'selected', items: [{ runId: 'verify-2', testId: 'unit', reason: { content: 'Included in suite quick.' } }] });
    const deferred = await queryVerificationHistory(context, { kind: 'deferred', runId: 'verify-2', pageSize: 10 });
    expect(deferred).toMatchObject({ kind: 'deferred', items: [{ testId: 'browser', reason: { content: 'Not included in suite quick.' } }] });
    const failures = await queryVerificationHistory(context, { kind: 'failures', runId: 'verify-2', pageSize: 10 });
    expect(failures).toMatchObject({ kind: 'failures', items: [{ classification: 'known', episodeId: fingerprint }] });
    const episodes = await queryVerificationHistory(context, { kind: 'episodes', runId: 'verify-2', pageSize: 10 });
    expect(episodes).toMatchObject({ kind: 'episodes', items: [{ fingerprint, occurrences: 2, status: 'open' }] });
  });

  it('marks an episode resolved only when the latest run of the same check passes', async () => {
    const { context, owners } = await fixture();
    const passed = record('verify-3', '2026-11-10T10:00:00.000Z', 'passed');
    owners.unshift({
      id: passed.id, worktree: false, result: passed.result, selection: passed.selection,
      events: [{ seq: 1, ts: passed.result.finishedAt, type: 'verification-result', result: passed.result, selection: passed.selection, suite: 'quick' }],
    });
    const episodes = await queryVerificationHistory(context, { kind: 'episodes', runId: 'verify-2', pageSize: 10 });
    expect(episodes).toMatchObject({ kind: 'episodes', items: [{ fingerprint, status: 'resolved', occurrences: 2 }] });
  });

  it('lazily returns an integrity-checked, redacted artifact and preserves history after worktree reclaim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar verification artifact '));
    roots.push(root);
    const content = 'safe output ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const path = '.factory/artifacts/verification/report.txt';
    const file = join(root, ...path.split('/'));
    await mkdir(join(root, '.factory/artifacts/verification'), { recursive: true });
    await writeFile(file, content);
    const result = verificationRunSchema.parse({
      ...record('verify-artifact', '2026-11-09T12:00:00.000Z', 'passed').result,
      artifacts: [{ path, mediaType: 'text/plain', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }],
    });
    const owner = { id: 'owner', worktree: false, worktreeReclaimedAt: '2026-11-09T13:00:00.000Z' };
    const context = {
      root,
      store: {
        listRuns: () => [owner],
        readEvents: () => [{ seq: 1, ts: result.finishedAt, type: 'verification-result', result, suite: 'quick', selection: { suite: 'quick', selected: [], deferred: [] } }],
        getRun: () => owner,
      },
    } as unknown as ProjectContext;
    const page = await queryVerificationHistory(context, { kind: 'artifacts', runId: result.verificationId, pageSize: 5 });
    if (!('kind' in page) || page.kind !== 'artifacts') throw new Error('expected artifacts page');
    const item = page.items[0]!;
    const artifactId = item.id;
    expect(item.data.content).toBeNull();
    const loaded = await readVerificationArtifact(context, result.verificationId, artifactId);
    expect(loaded.status).toBe(200);
    if (loaded.status !== 200) throw new Error('expected artifact response');
    expect(loaded.body.content).toContain('[REDACTED]');
    expect(loaded.body.truncated).toBe(false);
  });

  it('rejects a cursor from another query', async () => {
    const { context } = await fixture();
    const page = await queryVerificationHistory(context, { kind: 'runs', pageSize: 1 });
    if (!('kind' in page) || page.kind !== 'runs' || !page.page.nextCursor) throw new Error('expected paginated result');
    const result = await queryVerificationHistory(context, { kind: 'failures', pageSize: 1, cursor: page.page.nextCursor });
    expect(result).toMatchObject({ schemaVersion: 1, error: { code: 'stale_cursor' } });
  });
});
