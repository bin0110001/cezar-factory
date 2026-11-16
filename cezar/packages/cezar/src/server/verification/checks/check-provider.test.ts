import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECK_CATEGORIES, checkProviderConfigSchema, checkProviderJsonSchema, checkResultSchema, deriveCheckStatus,
} from './check-provider.js';

const provider = { name: 'fake-sca', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` };
const policy = { mandatory: true, timeoutMs: 60_000, onFailure: 'error' as const, onFeedUnavailable: 'unknown' as const, cache: { enabled: false } };
const check = (over: Record<string, unknown> = {}) => ({
  id: 'sca-main', category: 'sca', provider, scopes: ['full-repo'], triggers: ['pr-dev'], policy, ...over,
});
const cfg = (checks: unknown[]) => ({ version: 1, checks });
const ok = (v: unknown) => checkProviderConfigSchema.safeParse(v).success;
const result = (over: Record<string, unknown> = {}) => ({
  checkId: 'sca-main', provider, status: 'pass', execution: 'completed', feed: 'fresh', findingCount: 0, blockingFindingCount: 0, ...over,
});

describe('check provider config', () => {
  it('accepts every category with any provider identity', () => {
    for (const category of CHECK_CATEGORIES) expect(ok(cfg([check({ category })]))).toBe(true);
  });
  it('rejects bad input', () => {
    expect(ok(cfg([check({ category: 'trivy' })]))).toBe(false);
    expect(ok(cfg([check({ provider: { ...provider, digest: 'latest' } })]))).toBe(false);
    expect(ok(cfg([check({ scopes: [] })]))).toBe(false);
    expect(ok(cfg([check({ policy: { ...policy, onFeedUnavailable: 'pass' } })]))).toBe(false);
    expect(ok(cfg([check({ policy: { ...policy, onFailure: 'pass' } })]))).toBe(false);
    expect(ok(cfg([check(), check()]))).toBe(false);
    expect(ok({ version: 2, checks: [] })).toBe(false);
    expect(ok(cfg([check({ extra: 1 })]))).toBe(false);
  });
  it('requires a schedule for periodic-independent checks', () => {
    expect(ok(cfg([check({ triggers: ['periodic-independent'] })]))).toBe(false);
    expect(ok(cfg([check({ triggers: ['periodic-independent'], schedule: { cron: '0 3 * * *', timezone: 'UTC' } })]))).toBe(true);
  });
  it('matches the committed JSON schema', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../../../../schemas/check-provider.schema.json', import.meta.url), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(checkProviderJsonSchema())));
  });
});

describe('check results never pass on failure or unavailable feed', () => {
  it('rejects pass for a failed/not-run/timed-out execution, stale or unavailable feed, or blocking findings', () => {
    for (const execution of ['failed', 'timeout', 'not-run']) expect(checkResultSchema.safeParse(result({ execution })).success).toBe(false);
    for (const feed of ['stale', 'unavailable']) expect(checkResultSchema.safeParse(result({ feed })).success).toBe(false);
    expect(checkResultSchema.safeParse(result({ findingCount: 1, blockingFindingCount: 1 })).success).toBe(false);
    expect(checkResultSchema.safeParse(result()).success).toBe(true);
    expect(checkResultSchema.safeParse(result({ status: 'unknown', feed: 'unavailable' })).success).toBe(true);
  });
  it('derives statuses from the policy', () => {
    const p = checkProviderConfigSchema.parse(cfg([check()])).checks[0].policy;
    const base = { execution: 'completed' as const, feed: 'fresh' as const, findingCount: 0, blockingFindingCount: 0, policy: p };
    expect(deriveCheckStatus(base)).toBe('pass');
    expect(deriveCheckStatus({ ...base, feed: 'unavailable' })).toBe('unknown');
    expect(deriveCheckStatus({ ...base, execution: 'timeout' })).toBe('error');
    expect(deriveCheckStatus({ ...base, findingCount: 2 })).toBe('warn');
    expect(deriveCheckStatus({ ...base, findingCount: 2, blockingFindingCount: 1 })).toBe('fail');
  });
});
