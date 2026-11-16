import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { factoryControlCenterResponseSchema } from '@open-mercato/cezar-contract';
import { ProjectChannelService } from './project-channels.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('ProjectChannelService', () => {
  it('builds a bounded control-center read model from pointers and validated activation receipts', async () => {
    root = await mkdtemp(join(tmpdir(), 'cezar-control-center-'));
    const storeRoot = join(root, 'store');
    const projectRoot = join(root, 'project');
    const targetSha = 'a'.repeat(40);
    const stableSha = 'b'.repeat(40);
    const now = new Date().toISOString();
    const channelsDir = join(storeRoot, 'channels');
    const receiptDir = join(storeRoot, 'receipts', sha('demo').slice(0, 24), '1');
    await Promise.all([mkdir(channelsDir, { recursive: true }), mkdir(receiptDir, { recursive: true }), mkdir(join(storeRoot, 'quarantine'), { recursive: true })]);
    for (const [channel, currentSha] of [['dev', targetSha], ['stable', stableSha]] as const) {
      await writeFile(join(channelsDir, `${channel}.json`), JSON.stringify({
        schemaVersion: 'factory-release-channel-pointer/v1', channel, currentSha,
        currentPath: join(storeRoot, 'releases', currentSha), lastGoodSha: currentSha,
        lastGoodPath: join(storeRoot, 'releases', currentSha), updatedAt: now,
      }));
    }
    await writeFile(join(storeRoot, 'quarantine', `${stableSha}.json`), '{}');
    await writeFile(join(receiptDir, 'receipt.json'), JSON.stringify({
      schemaVersion: 'factory-deployment-receipt/v1', receiptId: 'receipt-1', targetId: 'demo',
      channel: 'dev', desiredSha: targetSha, actualSha: targetSha, observedSha: targetSha,
      artifactDigest: `sha256:${'c'.repeat(64)}`, idempotencyKey: `sha256:${'d'.repeat(64)}`,
      activationGeneration: 1, attempt: 1, state: 'active',
      compatibility: { status: 'compatible', capabilities: [] },
      requestedAt: now, stagedAt: now, activatedAt: now, observedAt: now,
    }));
    const service = new ProjectChannelService({ storeRoot, projectRoot, projectId: 'demo', configuredChannel: 'dev', compatibility: 'unknown', activeTasks: [] });
    const overview = await service.controlCenter();
    const response = factoryControlCenterResponseSchema.parse({ schemaVersion: 1, generatedAt: now, projects: [{
      id: 'demo', name: 'Demo', configuredChannel: overview.state.configuredChannel,
      compatibility: overview.state.compatibility, freshness: 'fresh', readAt: overview.state.readAt,
      findings: overview.state.findings, channels: overview.channels, history: overview.history,
    }] });
    expect(response.projects[0]?.channels).toMatchObject([
      { channel: 'dev', desiredSha: targetSha, activatedSha: targetSha, observedSha: targetSha, state: 'healthy' },
      { channel: 'stable', desiredSha: stableSha, state: 'quarantined' },
    ]);
    expect(response.projects[0]?.history).toMatchObject([{ id: 'receipt-1', channel: 'dev', state: 'active' }]);
  });

  it('separates configured and effective state, previews task pins and overrides, and records a token-bound request', async () => {
    root = await mkdtemp(join(tmpdir(), 'cezar-project-channel-'));
    const projectRoot = join(root, 'project');
    const storeRoot = join(root, 'store');
    const runtimeRoot = join(root, 'runtime');
    const files = ['.ai/factory/manifest.json', '.ai/factory/workflows/build.yaml'];
    await mkdir(join(projectRoot, '.ai/factory/workflows'), { recursive: true });
    await mkdir(join(runtimeRoot, 'workflows'), { recursive: true });
    await mkdir(join(storeRoot, 'channels'), { recursive: true });
    const baseContent = 'name: build\n';
    const overrideContent = 'name: local-build\n';
    await writeFile(join(projectRoot, files[1]!), overrideContent);
    await writeFile(join(projectRoot, files[0]!), JSON.stringify({ files: [{ path: 'workflows/build.yaml', sha256: sha(baseContent) }] }));
    await writeFile(join(runtimeRoot, 'workflows/build.yaml'), 'name: changed-build\n');
    const targetSha = 'a'.repeat(40);
    const configuredSha = 'c'.repeat(40);
    for (const [channel, currentSha] of [['dev', targetSha], ['stable', configuredSha]] as const) {
      await writeFile(join(storeRoot, 'channels', `${channel}.json`), JSON.stringify({
        schemaVersion: 'factory-release-channel-pointer/v1', channel, currentSha,
        currentPath: join(storeRoot, 'releases', currentSha), lastGoodSha: currentSha,
        lastGoodPath: join(storeRoot, 'releases', currentSha), updatedAt: new Date().toISOString(),
      }));
    }
    const service = new ProjectChannelService({
      storeRoot, projectRoot, projectId: 'demo', configuredChannel: 'stable', effectiveSha: 'b'.repeat(40),
      compatibility: 'compatible', activeTasks: [{ id: 'run-1', title: 'Build', status: 'running', channel: 'stable', sourceSha: 'b'.repeat(40) }],
    });
    const state = await service.state();
    expect(state.configuredSha).toBe(configuredSha);
    expect(state.effectiveSha).toBe('b'.repeat(40));
    expect(state.shadowDiff).toEqual({ expectedSha: configuredSha, observedSha: 'b'.repeat(40) });
    expect(state.activeTasks[0]?.sourceSha).toBe('b'.repeat(40));
    const preview = await service.preview('dev', { sourceSha: targetSha, runtimeRoot });
    expect(preview.allowed).toBe(true);
    if (!preview.allowed) throw new Error('expected an allowed preview');
    expect(preview.overrideDiff).toEqual([{ path: 'workflows/build.yaml', status: 'conflict' }]);
    expect(preview.warnings.some((warning) => warning.includes('stay pinned'))).toBe(true);
    expect(await service.recordRequest('dev', '0'.repeat(64), { sourceSha: targetSha, runtimeRoot }, 'local-operator')).toMatchObject({ status: 'refused', reason: 'stale-preview' });
    const requested = await service.recordRequest('dev', preview.token, { sourceSha: targetSha, runtimeRoot }, 'local-operator');
    expect(requested).toMatchObject({ status: 'requested', actor: 'local-operator', targetSha });
    const audit = await readFile(join(storeRoot, 'channel-change-audit', `${preview.token}.json`), 'utf8');
    expect(JSON.parse(audit)).toMatchObject({ schemaVersion: 'factory-channel-change-request/v1', previewToken: preview.token, toChannel: 'dev' });
  });
});
