import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodingRunArtifactByDigest } from '../workspace/coding-run-artifacts.ts';
import { storeVisualEvidence } from './visual-evidence-capture.ts';

const homeDirs: string[] = [];
async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'visual-evidence-'));
  homeDirs.push(home);
  return home;
}
afterEach(async () => { await Promise.all(homeDirs.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const evidence = {
  version: 1 as const, kind: 'png' as const, verificationId: 'verify-1', attempt: 1, role: 'actual',
  sessionId: 'session-1', testId: 'visual-check', commitSha: '1'.repeat(40), manifestSha256: '2'.repeat(64),
  policyVersion: 'policy-1', workerFingerprint: 'worker-1', capturedAt: '2026-11-22T12:00:00.000Z', retention: 'pending',
  accessPolicy: 'private' as const, redactionState: 'redacted' as const,
  renderer: { os: 'linux', resolution: { width: 1280, height: 720 }, dpi: 96, displayBackend: 'x11', renderer: 'software' as const,
    graphicsApi: null, driver: null, appVersion: '1.0', colorSettings: {}, renderFeatures: [] },
};

describe('storeVisualEvidence', () => {
  it('stores bounded bytes with digest-bound schema metadata and the canonical ref', async () => {
    const home = await tempHome();
    const ref = await storeVisualEvidence({ content: png, mediaType: 'image/png', evidence, redaction: 'already-redacted', home, retentionDays: 3, now: new Date('2026-11-22T12:00:00.000Z') });
    expect(ref.path).toMatch(/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
    expect(ref.visualEvidence).toMatchObject({ contentSha256: ref.sha256, storageReference: ref.path, retention: '2026-11-25T12:00:00.000Z' });
    await expect(readCodingRunArtifactByDigest({ sha256: ref.sha256, reference: ref.path, home, now: new Date('2026-11-22T12:00:00.000Z') }))
      .resolves.toMatchObject({ status: 'available', bytes: png });
    await expect(readCodingRunArtifactByDigest({ sha256: ref.sha256, reference: ref.path, home, now: new Date('2026-11-25T12:00:00.000Z') }))
      .resolves.toMatchObject({ status: 'expired' });
  });

  it('rejects partial and mismatched captures before storing them', async () => {
    const home = await tempHome();
    await expect(storeVisualEvidence({ content: new Uint8Array(), mediaType: 'image/png', evidence, redaction: 'already-redacted', home })).rejects.toThrow(/non-empty/);
    await expect(storeVisualEvidence({ content: Buffer.from('partial'), mediaType: 'image/png', evidence, redaction: 'already-redacted', home })).rejects.toThrow(/signature/);
    await expect(readCodingRunArtifactByDigest({ sha256: 'a'.repeat(64), reference: `sha256/aa/${'a'.repeat(64)}`, home })).resolves.toMatchObject({ status: 'missing' });
  });
});
