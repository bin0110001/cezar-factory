import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('Factory release run provenance', () => {
  it('persists the channel, source SHA and manifest digest with queued workflow content', async () => {
    root = await mkdtemp(join(tmpdir(), 'factory-release-run-'));
    const store = RunStore.open(join(root, '.ai/cezar'));
    const run = store.createRun({ title: 'pinned', workflow: 'test', task: 'test task', steps: [] });
    const factoryRelease = {
      channel: 'dev' as const,
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      resolvedAt: '2026-10-23T12:00:00Z',
    };
    store.updateRun(run.id, {
      factoryRelease,
      workflowDef: { name: 'test', source: 'built-in', steps: [], factoryRelease },
    });
    store.flush();

    const reopened = RunStore.open(join(root, '.ai/cezar'));
    expect(reopened.getRun(run.id)?.factoryRelease).toEqual(factoryRelease);
    expect(reopened.getRun(run.id)?.workflowDef?.factoryRelease).toEqual(factoryRelease);
  });
});
