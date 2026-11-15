import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectContext } from '../server/project-context.ts';
import { readEvidenceContent, readVerificationEvidence } from './visual-evidence.ts';
import { buildVisualEvidenceFixture, fixtureRenderer, type FixtureOptions } from './visual-evidence-fixtures.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(options: FixtureOptions, tamper?: (files: Map<string, Buffer>) => void) {
  const root = await mkdtemp(join(tmpdir(), 'cezar visual evidence '));
  roots.push(root);
  const { run, files } = buildVisualEvidenceFixture(options);
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  tamper?.(files);
  for (const [path, bytes] of files) await writeFile(join(root, path), bytes);
  const owner = { id: run.verificationId, worktree: false, events: [{ seq: 1, ts: run.finishedAt, type: 'verification-result', result: run, selection: {}, suite: 'visual' }] };
  const context = { root, store: { listRuns: () => [owner], readEvents: () => owner.events, getRun: () => owner } } as unknown as ProjectContext;
  return { context, run };
}
const local = { localOperator: true };
const reader = { localOperator: false };

describe.each(['browser', 'godot'] as const)('visual evidence from the %s fixture', (adapter) => {
  it('exposes revision-bound expected/actual/diff and a time-aligned multi-role timeline', async () => {
    const { context, run } = await setup({ adapter, verificationId: 'v1', roles: ['host', 'guest'], regress: true });
    const evidence = (await readVerificationEvidence(context, 'v1', reader, { commitSha: run.commitSha, roles: 'host,guest' }))!;
    expect(evidence).toMatchObject({ state: 'current', outcome: 'failed', commitSha: run.commitSha, policyVersions: ['visual-policy-1'] });
    const group = evidence.groups[0]!;
    expect(group.items.map((item) => item.side).sort()).toEqual(['diff', 'expected', 'other', 'other']);
    expect(evidence.timeline.map((entry) => entry.role)).toEqual(['expected', 'host', 'guest', 'diff']);
    expect(group.items.every((item) => item.preview === 'available' && item.download === 'available')).toBe(true);
    const preview = await readEvidenceContent(context, 'v1', group.items[0]!.id, 'preview', reader);
    expect(preview.status === 200 && preview.bytes.subarray(1, 4).toString()).toBe('PNG');
  });

  it('passes only when captures are complete and comparable', async () => {
    const { context } = await setup({ adapter, verificationId: 'v2', roles: ['actual'] });
    expect((await readVerificationEvidence(context, 'v2', reader, {}))?.outcome).toBe('passed');
  });
});

describe('visual evidence outcomes never present missing evidence as success', () => {
  it('is incomplete when a required role has no capture', async () => {
    const { context } = await setup({ adapter: 'browser', verificationId: 'v3', roles: ['host'] });
    const evidence = (await readVerificationEvidence(context, 'v3', reader, { roles: 'host,guest' }))!;
    expect(evidence.outcome).toBe('incomplete');
    expect(evidence.groups[0]).toMatchObject({ missingRoles: ['guest'] });
  });

  it('is inconclusive for an incompatible baseline', async () => {
    const { context } = await setup({ adapter: 'godot', verificationId: 'v4', baselineRenderer: { ...fixtureRenderer('godot'), driver: 'other-gpu', renderer: 'vulkan' } });
    const evidence = (await readVerificationEvidence(context, 'v4', reader, {}))!;
    expect(evidence.outcome).toBe('inconclusive');
  });

  it('is inconclusive when the requested revision differs (stale)', async () => {
    const { context } = await setup({ adapter: 'browser', verificationId: 'v5' });
    const evidence = (await readVerificationEvidence(context, 'v5', reader, { commitSha: '9'.repeat(40) }))!;
    expect(evidence).toMatchObject({ state: 'stale', outcome: 'inconclusive' });
  });

  it('reports state none, not success, when a run has no visual evidence (headless/disabled)', async () => {
    const { context } = await setup({ adapter: 'browser', verificationId: 'v6' });
    expect(await readVerificationEvidence(context, 'missing', reader, {})).toBeUndefined();
    const run = (context.store.listRuns() as unknown as Array<{ events: Array<{ result: { checks: Array<{ artifacts: unknown[] }> } }> }>)[0]!;
    run.events[0]!.result.checks[0]!.artifacts = [];
    const evidence = (await readVerificationEvidence(context, 'v6', reader, {}))!;
    expect(evidence).toMatchObject({ state: 'none', outcome: null, groups: [] });
  });
});

describe('visual evidence access control', () => {
  it('hides private evidence from readers on every path and shows it to the local operator', async () => {
    const { context } = await setup({ adapter: 'browser', verificationId: 'p1', accessPolicy: 'private' });
    const hidden = (await readVerificationEvidence(context, 'p1', reader, {}))!;
    expect(hidden.groups[0]).toMatchObject({ items: [], withheld: 3 });
    const visible = (await readVerificationEvidence(context, 'p1', local, {}))!;
    const id = visible.groups[0]!.items[0]!.id;
    expect(await readEvidenceContent(context, 'p1', id, 'preview', reader)).toEqual({ status: 404 });
    expect(await readEvidenceContent(context, 'p1', id, 'download', reader)).toEqual({ status: 404 });
    expect((await readEvidenceContent(context, 'p1', id, 'preview', local)).status).toBe(200);
  });

  it('never previews or lets a reader download unredacted (licensed) media; the local operator may download only', async () => {
    const { context } = await setup({ adapter: 'godot', verificationId: 'l1', redactionState: 'unredacted' });
    const id = (await readVerificationEvidence(context, 'l1', reader, {}))!.groups[0]!.items[0]!.id;
    expect((await readVerificationEvidence(context, 'l1', reader, {}))!.groups[0]!.items.every((item) => item.preview === 'denied' && item.download === 'denied')).toBe(true);
    expect((await readEvidenceContent(context, 'l1', id, 'preview', reader)).status).toBe(403);
    expect((await readEvidenceContent(context, 'l1', id, 'download', reader)).status).toBe(403);
    expect((await readEvidenceContent(context, 'l1', id, 'preview', local)).status).toBe(403);
    expect((await readEvidenceContent(context, 'l1', id, 'download', local)).status).toBe(200);
  });

  it('treats unknown redaction as unsafe for everyone', async () => {
    const { context } = await setup({ adapter: 'godot', verificationId: 'u1', redactionState: 'unknown' });
    const id = (await readVerificationEvidence(context, 'u1', local, {}))!.groups[0]!.items[0]!.id;
    expect((await readEvidenceContent(context, 'u1', id, 'preview', local)).status).toBe(403);
    expect((await readEvidenceContent(context, 'u1', id, 'download', local)).status).toBe(403);
  });

  it('rejects content that no longer matches the recorded digest', async () => {
    const { context } = await setup({ adapter: 'browser', verificationId: 'd1' }, (files) => { for (const [path] of files) files.set(path, Buffer.from('tampered')); });
    const id = (await readVerificationEvidence(context, 'd1', reader, {}))!.groups[0]!.items[0]!.id;
    expect((await readEvidenceContent(context, 'd1', id, 'download', reader)).status).toBe(409);
  });

  it('does not serve unknown artifact ids', async () => {
    const { context } = await setup({ adapter: 'browser', verificationId: 'n1' });
    expect((await readEvidenceContent(context, 'n1', 'nope', 'download', reader)).status).toBe(404);
  });
});
