import { describe, expect, it } from 'vitest';
import { evaluateScannerTrust, isPinnedReference } from './scanner-trust-policy.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const policy = {
  provider: 'trivy', reference: `registry.example/trivy@${DIGEST}`, pinnedDigest: DIGEST,
  signature: { required: true, trustedSigners: ['release@example.org'] },
  trustedSource: 'registry.example', updateProcess: 'reviewed PR changing this policy', dbMaxAgeHours: 48,
};
const good = { binaryPresent: true, observedDigest: DIGEST, verifiedSigner: 'release@example.org', dbUpdatedAt: '2026-11-16T00:00:00Z', now: '2026-11-16T12:00:00Z' };

describe('scanner trust policy', () => {
  it('trusts a pinned, verified, signed scanner with a fresh DB', () => {
    expect(evaluateScannerTrust(policy, good)).toEqual({ trusted: true, outcome: 'trusted', reasons: [] });
  });
  it('fails a compromised (digest-mismatched) scanner', () => {
    const v = evaluateScannerTrust(policy, { ...good, observedDigest: `sha256:${'b'.repeat(64)}` });
    expect(v).toMatchObject({ trusted: false, outcome: 'fail', reasons: ['digest_mismatch'] });
  });
  it('fails unsigned and untrusted-signer scanners', () => {
    expect(evaluateScannerTrust(policy, { ...good, verifiedSigner: undefined }).reasons).toContain('unsigned');
    expect(evaluateScannerTrust(policy, { ...good, verifiedSigner: 'evil@example.org' }).reasons).toContain('untrusted_signer');
  });
  it('fails unpinned references including latest', () => {
    for (const reference of ['registry.example/trivy:latest', 'registry.example/trivy', 'trivy:main']) {
      expect(evaluateScannerTrust({ ...policy, reference }, good).reasons).toContain('unpinned_reference');
    }
    expect(isPinnedReference('registry.example/trivy:0.60.0')).toBe(true);
  });
  it('is unknown, not green, for a missing binary, missing DB and expired offline DB', () => {
    expect(evaluateScannerTrust(policy, { ...good, binaryPresent: false })).toMatchObject({ trusted: false, outcome: 'unknown', reasons: ['binary_missing'] });
    expect(evaluateScannerTrust(policy, { ...good, dbUpdatedAt: undefined })).toMatchObject({ trusted: false, outcome: 'unknown', reasons: ['db_missing'] });
    expect(evaluateScannerTrust(policy, { ...good, now: '2026-11-20T00:00:00Z' })).toMatchObject({ trusted: false, outcome: 'unknown', reasons: ['db_expired'] });
  });
  it('applies the same policy to any provider and rejects a malformed policy', () => {
    expect(evaluateScannerTrust({ ...policy, provider: 'osv-scanner' }, good).trusted).toBe(true);
    expect(evaluateScannerTrust({ provider: 'x' }, good)).toMatchObject({ trusted: false, outcome: 'unknown', reasons: ['invalid_policy'] });
    expect(evaluateScannerTrust({ ...policy, pinnedDigest: 'latest' }, good).trusted).toBe(false);
  });
});
