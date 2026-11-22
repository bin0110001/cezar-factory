import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QuotaAdmissionStore } from './quota-admission-store.ts';

const now = Date.now();
const profile = {
  id: 'claude-main', provider: 'claude', enabled: true, maxConcurrency: 2,
  allowedModelIds: ['claude/opus'],
  windows: [{ name: '5h', limit: 40, remaining: 40, resetAt: new Date(now + 3 * 60 * 60_000).toISOString(), observedAt: new Date(now - 60_000).toISOString() }],
};
const candidate = {
  profileId: profile.id, provider: profile.provider, modelId: 'claude/opus', estimatedCost: { '5h': 40 },
};

describe('quota admission store', () => {
  let directory = '';
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('serializes concurrent processes so reservations cannot overbook', async () => {
    directory = mkdtempSync(join(tmpdir(), 'quota-admission-'));
    const store = new QuotaAdmissionStore(join(directory, 'state.json'));
    const profiles = new Map([[profile.id, profile]]);
    const first = store.transact(async (controller) => {
      const result = controller.admit('run-1', [candidate], profiles, { now });
      await new Promise((resolve) => setTimeout(resolve, 60));
      return result.status;
    });
    const second = store.transact((controller) => controller.admit('run-2', [candidate], profiles, { now }).status);
    expect((await Promise.all([first, second])).sort()).toEqual(['admitted', 'deferred']);
    const snapshot = await store.transact((controller) => controller.snapshot(now));
    expect(snapshot.leases).toHaveLength(1);
  });
});
