import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectChannelService } from './project-channels.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('ProjectChannelService', () => {
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
