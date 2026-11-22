import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadModelRoutingConfig, loadQuotaAdmissionPolicy, loadSubscriptionCapacityProfiles } from './config.ts';

describe('capacity configuration', () => {
  let directory = '';
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('keeps the legacy no-profile path when host profiles are absent', async () => {
    directory = mkdtempSync(join(tmpdir(), 'quota-config-'));
    expect(await loadSubscriptionCapacityProfiles(join(directory, 'missing.json'))).toEqual(new Map());
  });

  it('resolves only safe account references and drops the reference from admission data', async () => {
    directory = mkdtempSync(join(tmpdir(), 'quota-config-'));
    const path = join(directory, 'subscription-profiles.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, profiles: [{
      id: 'claude-personal', provider: 'claude', accountLabel: 'Personal', adapters: ['claude-code'],
      enabled: true, maxConcurrency: 1, allowedModelIds: ['claude-opus'],
      credentialRef: 'credstore:claude/personal', windows: [{
        name: '5h', kind: 'rolling', durationSeconds: 18_000, resetAt: null, unit: 'messages', limit: 100,
        remaining: 80, confidence: 'estimated', source: 'manual', observedAt: new Date().toISOString(), stalenessSeconds: 900,
      }],
    }] }));
    const profiles = await loadSubscriptionCapacityProfiles(path);
    expect(profiles.get('claude-personal')).not.toHaveProperty('credentialRef');
    expect(profiles.get('claude-personal')?.provider).toBe('claude');
  });

  it('loads optional project model routing config and fails closed on malformed files', async () => {
    directory = mkdtempSync(join(tmpdir(), 'quota-routing-'));
    expect(await loadModelRoutingConfig(directory)).toBeUndefined();
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'config', 'model-routing.json'), JSON.stringify({
      schemaVersion: 1,
      models: { fast: { provider: 'claude', modelId: 'claude-haiku' } },
      tiers: { quick: { candidates: ['fast'] } },
    }));
    expect((await loadModelRoutingConfig(directory))?.tiers?.quick?.candidates).toEqual(['fast']);
    writeFileSync(join(directory, 'config', 'model-routing.json'), '{');
    await expect(loadModelRoutingConfig(directory)).rejects.toThrow('model routing config could not be read');
  });

  it('defaults unknown capacity to conservative and validates an explicit host policy', async () => {
    directory = mkdtempSync(join(tmpdir(), 'quota-policy-'));
    const path = join(directory, 'policy.json');
    expect(await loadQuotaAdmissionPolicy(path)).toMatchObject({ unknownMode: 'conservative', optimisticUnknownLimit: 1 });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, unknownMode: 'optimistic', optimisticUnknownLimit: 2 }));
    expect(await loadQuotaAdmissionPolicy(path)).toMatchObject({ unknownMode: 'optimistic', optimisticUnknownLimit: 2 });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, unknownMode: 'unsafe' }));
    await expect(loadQuotaAdmissionPolicy(path)).rejects.toThrow('quota admission policy is malformed');
  });
});
