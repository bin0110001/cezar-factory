import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  computeFactoryManifestDigest,
  computeFactoryActivationIdempotencyKey,
  factoryDeploymentReceiptSchema,
  factoryReleaseLeaseSchema,
  factoryReleaseManifestSchema,
  factoryReleaseStateSchema,
  parseFactoryDeploymentReceipt,
  parseFactoryReleaseManifest,
  verifyFactoryReleaseManifest,
  verifyFactoryDeploymentReceipt,
} from '@open-mercato/cezar-contract';

const fixtures = new URL('../../../../../schemas/factory-release/fixtures/', import.meta.url);
async function readFixture(name: string): Promise<any> {
  return JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('Factory release contracts (#62)', () => {
  it('accepts the shared v1 manifest, state, active and incompatible receipts, and task leases', async () => {
    const manifest = await readFixture('manifest-valid.json');
    expect(factoryReleaseManifestSchema.safeParse(manifest).success).toBe(true);
    expect(factoryReleaseStateSchema.safeParse(await readFixture('state-verified.json')).success).toBe(true);
    expect(factoryDeploymentReceiptSchema.safeParse(await readFixture('receipt-active.json')).success).toBe(true);
    expect(factoryDeploymentReceiptSchema.safeParse(await readFixture('receipt-incompatible.json')).success).toBe(true);
    expect(factoryDeploymentReceiptSchema.safeParse(await readFixture('receipt-staged.json')).success).toBe(true);
    expect(factoryReleaseLeaseSchema.safeParse(await readFixture('lease-active.json')).success).toBe(true);
    expect(factoryReleaseLeaseSchema.safeParse(await readFixture('lease-expired.json')).success).toBe(true);
  });

  it('classifies unknown manifest and receipt schema versions without parsing them as v1', async () => {
    expect(parseFactoryReleaseManifest(await readFixture('manifest-unknown-schema.json')).status).toBe('unknown-schema');
    expect(parseFactoryDeploymentReceipt({ schemaVersion: 'factory-deployment-receipt/v2' }).status).toBe('unknown-schema');
  });

  it('rejects unsafe and ambiguous manifest paths, hashes and source object formats', async () => {
    const manifest = await readFixture('manifest-valid.json');
    expect(factoryReleaseManifestSchema.safeParse({ ...manifest, files: [{ ...manifest.files[0], path: '../VERSION' }] }).success).toBe(false);
    expect(factoryReleaseManifestSchema.safeParse({ ...manifest, files: [...manifest.files].reverse() }).success).toBe(false);
    expect(factoryReleaseManifestSchema.safeParse({ ...manifest, source: { ...manifest.source, gitObjectFormat: 'sha256' } }).success).toBe(false);
    expect(factoryReleaseManifestSchema.safeParse({ ...manifest, files: [manifest.files[0], manifest.files[0]] }).success).toBe(false);
  });

  it('rejects invalid state, receipt and lease transitions', async () => {
    const state = await readFixture('state-verified.json');
    expect(factoryReleaseStateSchema.safeParse({ ...state, verification: undefined }).success).toBe(false);
    const receipt = await readFixture('receipt-active.json');
    expect(factoryDeploymentReceiptSchema.safeParse({ ...receipt, observedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).success).toBe(false);
    expect(factoryDeploymentReceiptSchema.safeParse({ ...receipt, state: 'incompatible' }).success).toBe(false);
    const lease = await readFixture('lease-active.json');
    expect(factoryReleaseLeaseSchema.safeParse({ ...lease, expiresAt: lease.heartbeatAt }).success).toBe(false);
    expect(factoryReleaseLeaseSchema.safeParse({ ...lease, state: 'released' }).success).toBe(false);
  });

  it('verifies canonical manifest, bundle and every extracted file digest before activation', async () => {
    const manifest = await readFixture('manifest-valid.json');
    const artifact = await readFixture('artifact-payload.json');
    const encoder = new TextEncoder();
    const entries = Object.entries(artifact.files).map(([path, content]) => ({ path, kind: 'file' as const, bytes: encoder.encode(content as string) }));
    const bundle = encoder.encode(artifact.bundleText);
    const evidenceBytes = new Uint8Array(await readFile(new URL('verification-evidence.json', fixtures)));
    const evidence = { path: artifact.verificationEvidencePath, bytes: evidenceBytes };
    expect(await computeFactoryManifestDigest(manifest)).toBe(manifest.manifestDigest);
    expect(await verifyFactoryReleaseManifest(manifest, bundle, entries, evidence)).toEqual({ valid: true });
    expect(await verifyFactoryReleaseManifest(manifest, bundle, entries)).toEqual({ valid: false, reason: 'verification-evidence-missing' });
    expect(await verifyFactoryReleaseManifest({ ...manifest, manifestDigest: `sha256:${'0'.repeat(64)}` }, bundle, entries, evidence)).toEqual({ valid: false, reason: 'manifest-digest-mismatch' });
    expect(await verifyFactoryReleaseManifest(manifest, encoder.encode('tampered bundle'), entries, evidence)).toEqual({ valid: false, reason: 'artifact-digest-mismatch' });
    expect(await verifyFactoryReleaseManifest(manifest, bundle, entries, { ...evidence, bytes: encoder.encode('tampered evidence') })).toEqual({ valid: false, reason: 'verification-evidence-digest-mismatch' });
    const skippedBytes = encoder.encode(JSON.stringify({ resultVersion: 1, status: 'skipped' }));
    const skippedManifest = { ...manifest, verification: { ...manifest.verification, digest: await sha256(skippedBytes) } };
    skippedManifest.manifestDigest = await computeFactoryManifestDigest(skippedManifest);
    expect(await verifyFactoryReleaseManifest(skippedManifest, bundle, entries, { ...evidence, bytes: skippedBytes })).toEqual({ valid: false, reason: 'verification-evidence-invalid' });
    expect(await verifyFactoryReleaseManifest(manifest, bundle, entries.map((entry, index) => index === 0 ? { ...entry, bytes: encoder.encode('tampered') } : entry), evidence)).toEqual({ valid: false, reason: 'file-digest-mismatch' });
    expect(await verifyFactoryReleaseManifest(manifest, bundle, [...entries, { path: 'escape', kind: 'symlink', bytes: new Uint8Array() }], evidence)).toEqual({ valid: false, reason: 'unsafe-artifact-entry' });
    expect(await verifyFactoryReleaseManifest({ ...manifest, schemaVersion: 'factory-release-manifest/v2' }, bundle, entries, evidence)).toEqual({ valid: false, reason: 'unknown-schema' });
  });

  it('derives idempotency keys from the stable activation tuple', async () => {
    const fixture = await readFixture('receipt-active.json');
    const first = await computeFactoryActivationIdempotencyKey({ targetId: fixture.targetId, channel: fixture.channel, desiredSha: fixture.desiredSha, activationGeneration: fixture.activationGeneration });
    const retry = await computeFactoryActivationIdempotencyKey({ targetId: 'cezar-factory', channel: 'dev', desiredSha: '0123456789abcdef0123456789abcdef01234567', activationGeneration: 4 });
    const next = await computeFactoryActivationIdempotencyKey({ targetId: 'cezar-factory', channel: 'dev', desiredSha: '0123456789abcdef0123456789abcdef01234567', activationGeneration: 5 });
    expect(first).toBe(fixture.idempotencyKey);
    expect(first).toBe(retry);
    expect(first).not.toBe(next);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((await verifyFactoryDeploymentReceipt(fixture)).valid).toBe(true);
    expect(await verifyFactoryDeploymentReceipt({ ...fixture, activationGeneration: 7 })).toEqual({ valid: false, reason: 'idempotency-key-mismatch' });
  });
});
