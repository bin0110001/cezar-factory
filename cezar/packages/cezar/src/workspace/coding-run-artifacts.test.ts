import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codingEvidenceReferenceSchema } from '@open-mercato/cezar-contract';
import { pruneCodingRunArtifacts, readCodingRunArtifact, storeCodingRunArtifact } from './coding-run-artifacts.ts';

const roots: string[] = [];
const start = new Date('2026-11-10T12:00:00.000Z');

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'coding-run-artifacts-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('content-addressed coding-run artifacts', () => {
  it('deduplicates by digest and verifies bytes before returning evidence', async () => {
    const home = await temporaryHome();
    const content = Buffer.from('bounded synthetic evidence');
    const first = await storeCodingRunArtifact({ content, mediaType: 'text/plain', home, now: start });
    const second = await storeCodingRunArtifact({ content, mediaType: 'text/plain', home, now: start });

    expect(first.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(first.reference).toBe(`sha256/${first.sha256.slice(0, 2)}/${first.sha256}`);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(codingEvidenceReferenceSchema.parse(first)).toMatchObject({ evidenceId: first.evidenceId, expiresAt: first.expiresAt });
    await expect(readCodingRunArtifact({ reference: first, home, now: start })).resolves.toMatchObject({ status: 'available', bytes: content });
  });

  it('reports tampering, expiration and missing files without substituting data', async () => {
    const home = await temporaryHome();
    const reference = await storeCodingRunArtifact({ content: Buffer.from('original'), mediaType: 'text/plain', home, retentionDays: 1, now: start });
    await expect(readCodingRunArtifact({ reference, home, now: new Date('2026-11-12T00:00:00.000Z') })).resolves.toMatchObject({ status: 'expired' });

    const blob = join(home, 'coding-run-artifacts', reference.reference);
    await writeFile(blob, 'tampered');
    await expect(readCodingRunArtifact({ reference, home, now: start })).resolves.toMatchObject({ status: 'corrupt', reason: 'digest-mismatch' });
    await rm(blob);
    await expect(readCodingRunArtifact({ reference, home, now: start })).resolves.toMatchObject({ status: 'missing' });
  });

  it('prunes expired content and keeps unexpired content', async () => {
    const home = await temporaryHome();
    const old = await storeCodingRunArtifact({ content: Buffer.from('old'), mediaType: 'text/plain', home, retentionDays: 1, now: start });
    const fresh = await storeCodingRunArtifact({ content: Buffer.from('fresh'), mediaType: 'text/plain', home, retentionDays: 30, now: start });
    const result = await pruneCodingRunArtifacts({ home, now: new Date('2026-11-12T00:00:00.000Z') });
    expect(result).toEqual({ deleted: 1, retained: 1, invalid: 0 });
    await expect(readCodingRunArtifact({ reference: old, home, now: start })).resolves.toMatchObject({ status: 'missing' });
    await expect(readCodingRunArtifact({ reference: fresh, home, now: start })).resolves.toMatchObject({ status: 'available' });
  });

  it('enforces a size bound before writing bytes', async () => {
    const home = await temporaryHome();
    await expect(storeCodingRunArtifact({ content: new Uint8Array(16 * 1024 * 1024 + 1), mediaType: 'application/octet-stream', home }))
      .rejects.toThrow(/no larger than/);
  });

  it('redacts text by default, requires a binary redaction assertion, and enforces the store byte cap', async () => {
    const home = await temporaryHome();
    const unsafe = await storeCodingRunArtifact({
      content: Buffer.from('credential ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'), mediaType: 'text/plain', home, now: start,
    });
    const loaded = await readCodingRunArtifact({ reference: unsafe, home, now: start });
    expect(loaded.status).toBe('available');
    if (loaded.status === 'available') expect(Buffer.from(loaded.bytes).toString('utf8')).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');

    await expect(storeCodingRunArtifact({ content: Buffer.from([1, 2]), mediaType: 'application/octet-stream', home }))
      .rejects.toThrow(/binary artifacts require redaction/);
    const cappedHome = await temporaryHome();
    await storeCodingRunArtifact({ content: Buffer.from('one'), mediaType: 'text/plain', home: cappedHome, maxStoreBytes: 3 });
    await expect(storeCodingRunArtifact({ content: Buffer.from('two'), mediaType: 'text/plain', home: cappedHome, maxStoreBytes: 3 }))
      .rejects.toThrow(/store limit exceeded/);
  });
});
