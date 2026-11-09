import { describe, expect, it } from 'vitest';
import {
  assertVersionBumpHasAliases,
  fingerprintFinding,
  FINGERPRINT_STRATEGIES,
  resolveFingerprintAlias,
} from './fingerprint.ts';

const finding = (overrides: Partial<Parameters<typeof fingerprintFinding>[0]> = {}) => fingerprintFinding({
  kind: 'test-failure',
  checkId: 'unit',
  code: 'ASSERTION',
  message: 'Expected 3 but received 4 at src/a.test.ts:18',
  file: 'src/a.test.ts',
  line: 18,
  ...overrides,
});

describe('verification finding fingerprints', () => {
  it('is stable across line movement, file rename and volatile runtime details', () => {
    expect(finding()).toEqual(finding({
      message: 'Expected 3 but received 4 at renamed/b.test.ts:207 (PID=3481, 120ms)',
      file: 'renamed/b.test.ts',
      line: 207,
    }));
    expect(finding({ message: 'connection failed at' })).toEqual(finding({
      message: 'connection failed at 2026-11-09T18:00:00Z (PID=3481, 120ms, port=43817, 0xabcdef123456, 550e8400-e29b-41d4-a716-446655440000)',
    }));
  });

  it('keeps distinct failure kinds, checks, codes and messages distinct', () => {
    const base = finding().fingerprint;
    const variants = [
      finding({ kind: 'parse-error' }).fingerprint,
      finding({ checkId: 'integration' }).fingerprint,
      finding({ code: 'TYPE_ERROR' }).fingerprint,
      finding({ message: 'Expected 3 but received 5 at src/a.test.ts:18' }).fingerprint,
    ];
    expect(new Set([base, ...variants]).size).toBe(5);
  });

  it('is deterministic for repeated, split and merged diagnostic input', () => {
    const repeated = finding();
    const split = finding({ message: 'Expected 3 but received 4 at src/a.test.ts:18' });
    const merged = finding({ message: 'Expected 3 but received 4 at src/a.test.ts:18\n at src/a.test.ts:18' });
    expect(finding()).toEqual(repeated);
    expect(split).toEqual(repeated);
    expect(merged.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(merged).toEqual(finding({ message: 'Expected 3 but received 4 at src/a.test.ts:18\n at src/a.test.ts:18' }));
  });

  it('records the strategy metadata and supports explicit aliases on a version bump', () => {
    const current = finding();
    expect(current).toMatchObject({
      strategyId: FINGERPRINT_STRATEGIES['test-failure'].id,
      strategyVersion: FINGERPRINT_STRATEGIES['test-failure'].version,
    });
    const old = 'a'.repeat(64);
    const next = 'b'.repeat(64);
    expect(() => assertVersionBumpHasAliases(1, 2, {})).toThrow(/requires explicit aliases/);
    expect(() => assertVersionBumpHasAliases(1, 2, { [old]: next })).not.toThrow();
    expect(resolveFingerprintAlias(old, { [old]: next })).toBe(next);
    expect(() => resolveFingerprintAlias(old, { [old]: next, [next]: old })).toThrow(/cycle/);
  });
});
