import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFactoryManifestDigest } from '@open-mercato/cezar-contract';
import { spawnSync } from 'node:child_process';
import { materializeRuntimeScript, resolveFactoryRelease, resolvePinnedFactoryRelease } from './resolver.ts';

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
  return { store, release: await realpath(release), sha, manifest };
}

const project = (factoryChannel?: 'dev' | 'stable') => [{ id: 'shop', root: 'C:\\shop', name: 'Shop', addedAt: '', lastOpenedAt: '', source: 'local' as const, ...(factoryChannel ? { factoryChannel } : {}) }];

async function optionsFor(fixture: Awaited<ReturnType<typeof fixtureStore>>, channel: 'dev' | 'stable' = 'stable') {
  const runtimeRoot = join(temp, 'runtimes', fixture.sha);
  const exists = await readFile(join(runtimeRoot, 'scripts', 'factory-startup.ps1'), 'utf8').then(() => true, () => false);
  if (!exists) {
    await mkdir(join(runtimeRoot, 'scripts'), { recursive: true });
    await writeFile(join(runtimeRoot, 'scripts', 'factory-startup.ps1'), '# pinned startup');
  }
  return {
    env: { CEZ_FACTORY_RELEASE_STORE: fixture.store, FACTORY_RUNTIME_SOURCE_ROOT: join(temp, 'source'), CEZ_HOME: join(temp, 'cez-home') },
    projects: project(channel),
    runtimeMaterializer: async () => runtimeRoot,
  };
}

/** First interpreter that runs; null when none does. */
function findPython(): string[] | null {
  for (const candidate of [[process.env.CEZ_FACTORY_CONTROLLER_PYTHON ?? ''], ['python3'], ['python'], ['py', '-3']]) {
    if (!candidate[0]) continue;
    const probe = spawnSync(candidate[0], [...candidate.slice(1), '-c', 'import sys; sys.exit(0)'], { windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return null;
}

describe('pinned runtime materialization script', () => {
  // Regression: statements were joined with '; ', and a one-line `if ...: raise` after ';' is a
  // SyntaxError, so every materialization failed and /api/v1/factory-release answered 503. The fake
  // materializer in the tests below never runs this script, so it must be checked directly.
  it('is valid Python', () => {
    const python = findPython();
    expect(python, 'no Python interpreter found; the materialization script cannot be checked').not.toBeNull();
    const [command, ...prefix] = python!;
    const result = spawnSync(command, [...prefix, '-c', 'import ast, sys; ast.parse(sys.argv[1])', materializeRuntimeScript()], { encoding: 'utf8', windowsHide: true });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('keeps one statement per line', () => {
    const lines = materializeRuntimeScript().split('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((line) => /;\s*(if|for|while|with|try)\b/.test(line))).toEqual([]);
  });

  // Regression: the script indexed verify_release()'s return value as if it were the manifest
  // (KeyError 'files'). Syntax checking cannot see that, so run it against a release built by the
  // real controller, with a real git archive, exactly as Cezar does.
  it('materializes a release built by the real controller', async () => {
    const python = findPython();
    expect(python, 'no Python interpreter found; materialization cannot be exercised').not.toBeNull();
    const [command, ...prefix] = python!;
    const factoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    temp = await mkdtemp(join(tmpdir(), 'factory-materialize-'));
    const repo = join(temp, 'repo');
    const store = join(temp, 'store');
    const destination = join(temp, 'runtime', 'tree');
    await mkdir(join(repo, 'scripts'), { recursive: true });
    await writeFile(join(repo, 'scripts', 'factory-startup.ps1'), '# startup');
    const git = (...args: string[]) => {
      const out = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true });
      expect(out.status, out.stderr).toBe(0);
      return out.stdout.trim();
    };
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'release fixture');
    const sha = git('rev-parse', 'HEAD');

    const build = spawnSync(command, [...prefix, '-c', [
      'import json, pathlib, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from scripts.release.factory_release_controller import ReleaseController',
      'controller = ReleaseController(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), "origin", "stable", 3, 30, 1)',
      'print(json.dumps(controller._build(sys.argv[4], "materialize-test")))',
    ].join('\n'), factoryRoot, repo, store, sha], { encoding: 'utf8', windowsHide: true });
    expect(build.status, build.stderr).toBe(0);
    const { manifestDigest } = JSON.parse(build.stdout.trim().split('\n').pop()!) as { manifestDigest: string };

    const run = spawnSync(command, [...prefix, '-c', materializeRuntimeScript(), factoryRoot, store, sha, manifestDigest, destination], { encoding: 'utf8', windowsHide: true });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(await readFile(join(destination, 'scripts', 'factory-startup.ps1'), 'utf8')).toBe('# startup');
    expect(JSON.parse(await readFile(join(destination, '.factory-runtime.json'), 'utf8'))).toEqual({ sourceSha: sha, manifestDigest });
  });
});

describe('Factory release resolver', () => {
  it('selects the registry channel and returns its verified immutable SHA', async () => {
    const fixture = await fixtureStore('dev');
    const result = await resolveFactoryRelease('shop', await optionsFor(fixture, 'dev'));
    expect(result).toMatchObject({ projectId: 'shop', channel: 'dev', sourceSha: fixture.sha, manifestDigest: fixture.manifest.manifestDigest, releaseRoot: fixture.release, runtimeRoot: join(temp, 'runtimes', fixture.sha) });
  });

  it('uses the mounted Factory source checkout for commands and fails early if its startup script is missing', async () => {
    const fixture = await fixtureStore('dev');
    const options = await optionsFor(fixture, 'dev');
    const result = await resolveFactoryRelease('shop', options);
    expect(result.releaseRoot).toBe(fixture.release);
    expect(result.runtimeRoot).toBe(join(temp, 'runtimes', fixture.sha));

    await rm(join(result.runtimeRoot, 'scripts', 'factory-startup.ps1'));
    await expect(resolveFactoryRelease('shop', options)).rejects.toMatchObject({
      code: 'runtime-materialization-failed',
    });
  });

  it('keeps queued tasks pinned to their saved SHA after the channel pointer moves', async () => {
    const fixture = await fixtureStore('dev');
    const original = await resolveFactoryRelease('shop', await optionsFor(fixture, 'dev'));
    await writeFile(join(fixture.store, 'channels', 'dev.json'), JSON.stringify({ schemaVersion: 'factory-release-channel-pointer/v1', channel: 'dev', currentSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', currentPath: join(fixture.store, 'releases', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), lastGoodSha: fixture.sha, lastGoodPath: fixture.release, updatedAt: '2026-10-23T12:05:00Z' }));
    const resumed = await resolvePinnedFactoryRelease('shop', original, await optionsFor(fixture, 'stable'));
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
