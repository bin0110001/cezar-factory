import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFactoryManifestDigest } from '@open-mercato/cezar-contract';
import { resolveFactoryRelease, resolvePinnedFactoryRelease } from './resolver.ts';

const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let temp = '';
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = ''; });

async function fixtureStore(channel: 'dev' | 'stable' = 'stable') {
  temp = await mkdtemp(join(tmpdir(), 'factory-release-resolver-'));
  const store = join(temp, 'store');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const release = join(store, 'releases', sha);
  await mkdir(join(store, 'channels'), { recursive: true });
  await mkdir(join(release, 'verification'), { recursive: true });
  const artifact = Buffer.from('immutable artifact');
  const evidence = Buffer.from(JSON.stringify({ resultVersion: 1, status: 'passed', commitSha: sha }));
  const fixtureDir = new URL('../../../../../schemas/factory-release/fixtures/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest-valid.json', fixtureDir), 'utf8'));
  manifest.source.sha = sha;
  manifest.artifact = { format: 'tar', byteSize: artifact.length, sha256: sha256(artifact) };
  manifest.verification = { resultVersion: 1, status: 'passed', digest: sha256(evidence), evidenceRef: `verification/${sha}.json` };
  manifest.manifestDigest = await computeFactoryManifestDigest(manifest);
  const state = { schemaVersion: 'factory-release-state/v1', sourceSha: sha, manifestDigest: manifest.manifestDigest, state: 'verified', verification: manifest.verification, updatedAt: '2026-10-23T12:00:00Z' };
  await writeFile(join(release, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(release, 'state.json'), JSON.stringify(state));
  await writeFile(join(release, 'artifact.tar'), artifact);
  await writeFile(join(release, 'verification', `${sha}.json`), evidence);
  await writeFile(join(store, 'channels', `${channel}.json`), JSON.stringify({ schemaVersion: 'factory-release-channel-pointer/v1', channel, currentSha: sha, currentPath: release, lastGoodSha: sha, lastGoodPath: release, updatedAt: '2026-10-23T12:00:00Z' }));
  return { store, release, sha, manifest };
}

const project = (factoryChannel?: 'dev' | 'stable') => [{ id: 'shop', root: 'C:\\shop', name: 'Shop', addedAt: '', lastOpenedAt: '', source: 'local' as const, ...(factoryChannel ? { factoryChannel } : {}) }];

describe('Factory release resolver', () => {
  it('selects the registry channel and returns its verified immutable SHA', async () => {
    const fixture = await fixtureStore('dev');
    const result = await resolveFactoryRelease('shop', { env: { CEZ_FACTORY_RELEASE_STORE: fixture.store }, projects: project('dev') });
    expect(result).toMatchObject({ projectId: 'shop', channel: 'dev', sourceSha: fixture.sha, manifestDigest: fixture.manifest.manifestDigest, releaseRoot: fixture.release, runtimeRoot: fixture.release });
  });

  it('keeps queued tasks pinned to their saved SHA after the channel pointer moves', async () => {
    const fixture = await fixtureStore('dev');
    const original = await resolveFactoryRelease('shop', { env: { CEZ_FACTORY_RELEASE_STORE: fixture.store }, projects: project('dev') });
    await writeFile(join(fixture.store, 'channels', 'dev.json'), JSON.stringify({ schemaVersion: 'factory-release-channel-pointer/v1', channel: 'dev', currentSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', currentPath: join(fixture.store, 'releases', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), lastGoodSha: fixture.sha, lastGoodPath: fixture.release, updatedAt: '2026-10-23T12:05:00Z' }));
    const resumed = await resolvePinnedFactoryRelease('shop', original, { env: { CEZ_FACTORY_RELEASE_STORE: fixture.store }, projects: project('stable') });
    expect(resumed.sourceSha).toBe(fixture.sha);
    expect(resumed.manifestDigest).toBe(original.manifestDigest);
  });

  it('defaults existing projects to stable and rejects unknown projects or missing pointers', async () => {
    const fixture = await fixtureStore();
    await expect(resolveFactoryRelease('missing', { env: { CEZ_FACTORY_RELEASE_STORE: fixture.store }, projects: project() })).rejects.toMatchObject({ code: 'unknown-project' });
    await expect(resolveFactoryRelease('shop', { env: { CEZ_FACTORY_RELEASE_STORE: join(temp, 'empty') }, projects: project() })).rejects.toMatchObject({ code: 'pointer-missing' });
  });

  it('fails closed when the pointer, manifest digest, or immutable artifact disagrees', async () => {
    const fixture = await fixtureStore();
    const pointerPath = join(fixture.store, 'channels', 'stable.json');
    await writeFile(pointerPath, JSON.stringify({ schemaVersion: 'factory-release-channel-pointer/v2' }));
    await expect(resolveFactoryRelease('shop', { env: { CEZ_FACTORY_RELEASE_STORE: fixture.store }, projects: project() })).rejects.toMatchObject({ code: 'pointer-invalid' });
    const valid = await fixtureStore();
    const manifest = JSON.parse(await readFile(join(valid.release, 'manifest.json'), 'utf8'));
    manifest.build.id = 'tampered';
    await writeFile(join(valid.release, 'manifest.json'), JSON.stringify(manifest));
    await expect(resolveFactoryRelease('shop', { env: { CEZ_FACTORY_RELEASE_STORE: valid.store }, projects: project() })).rejects.toMatchObject({ code: 'manifest-digest-mismatch' });
  });

  it('rejects releases that require runtime capabilities this Cezar does not provide', async () => {
    const fixture = await fixtureStore();
    fixture.manifest.compatibility.requiredCapabilities = ['future-runtime-feature-v2'];
    fixture.manifest.manifestDigest = await computeFactoryManifestDigest(fixture.manifest);
    await writeFile(join(fixture.release, 'manifest.json'), JSON.stringify(fixture.manifest));
    const state = JSON.parse(await readFile(join(fixture.release, 'state.json'), 'utf8'));
    state.manifestDigest = fixture.manifest.manifestDigest;
    await writeFile(join(fixture.release, 'state.json'), JSON.stringify(state));
    await expect(resolveFactoryRelease('shop', { env: { CEZ_FACTORY_RELEASE_STORE: fixture.store }, projects: project() })).rejects.toMatchObject({ code: 'incompatible-release' });
  });
});
