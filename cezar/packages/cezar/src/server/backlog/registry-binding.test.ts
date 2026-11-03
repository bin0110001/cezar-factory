import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimWorkspace } from '../../workspace/lifecycle.ts';
import { ManifestStore } from '../impact/manifest-store.ts';
import { createBacklogAdmission, runningFromRegistry } from './admission-hook.ts';
import { BacklogStore } from './store.ts';

const GIT_ID = ['-c', 'user.name=T', '-c', 'user.email=t@example.test'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const SHA = 'a'.repeat(40);
const manifest = (n: number, rev: number, files: string[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, issue: { repository: 'o/r', number: n }, repo: { repository: 'o/r', branch: 'dev', baseSha: SHA }, manifestRevision: rev,
  generatedAt: 'x', mode: 'code-first', coverage: 'complete', files: files.map((path) => ({ path, op: 'modify', confidence: 0.9, source: 'code-graph' })), ...extra,
});

describe('manifest store', () => {
  let home: string;
  beforeEach(() => { home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cez-manifest-'))); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('persists validated manifests, rejects invalid and stale revisions, and treats corruption as unknown', () => {
    const s = new ManifestStore({ home });
    expect(s.get('o/r', 1)).toBeNull();
    expect(s.save(manifest(1, 1, ['a.cs']))).toEqual({ saved: true, replaced: false });
    expect(s.save(manifest(1, 2, ['b.cs']))).toEqual({ saved: true, replaced: true });
    expect(s.save(manifest(1, 2, ['c.cs']))).toEqual({ saved: false, reason: 'stale-revision' });
    expect(s.save(manifest(1, 1, ['c.cs']))).toEqual({ saved: false, reason: 'stale-revision' });
    expect(s.save({ schemaVersion: 9 })).toMatchObject({ saved: false, reason: 'invalid' });
    expect(s.save(manifest(2, 1, ['../escape']))).toMatchObject({ saved: false, reason: 'invalid' });
    expect(s.get('O/R', 1)!.files[0]!.path).toBe('b.cs');
    s.save(manifest(3, 1, ['z.cs']));
    expect(s.list('o/r').map((m) => m.issue.number)).toEqual([1, 3]);
    expect(new ManifestStore({ home }).get('o/r', 1)!.manifestRevision).toBe(2); // survives restart
  });
});

describe('registry-backed running work', () => {
  let home: string; let repo: string; let oldHome: string | undefined;
  beforeEach(() => {
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cez-bind-home-')));
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'cez-bind-repo-')));
    oldHome = process.env.CEZ_HOME; process.env.CEZ_HOME = home;
    git(repo, 'init', '-q', '-b', 'dev');
    writeFileSync(join(repo, 'base.txt'), 'b');
    git(repo, ...GIT_ID, 'add', 'base.txt'); git(repo, ...GIT_ID, 'commit', '-q', '-m', 'base');
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.CEZ_HOME; else process.env.CEZ_HOME = oldHome;
    rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true });
  });

  it('feeds live workspace claims and their manifests into the admission decision', async () => {
    const manifests = new ManifestStore({ home });
    manifests.save(manifest(7, 1, ['src/a.cs']));
    await claimWorkspace({ issue: '7', cwd: repo, owner: 'external:test:7', base: 'dev' });
    const running = await runningFromRegistry(repo, 'o/r', manifests);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ id: 'o/r#7', repository: 'o/r' });
    expect(running[0]!.manifest!.files[0]!.path).toBe('src/a.cs');

    const store = new BacklogStore({ path: ':memory:' });
    try {
      const hook = createBacklogAdmission({
        repository: 'o/r', store, mode: 'enforce', config: { reservedHighPrioritySlots: 0, maxPerRepository: 5 },
        running: () => runningFromRegistry(repo, 'o/r', manifests),
        manifest: (n) => manifests.get('o/r', n),
      });
      manifests.save(manifest(8, 1, ['src/A.cs']));
      manifests.save(manifest(9, 1, ['src/other.cs']));
      const clash = await hook({ number: 8, labels: ['P1', 'factory:ready'], timestamp: '2026-11-01T00:00:00Z' });
      expect(clash.decision).toMatchObject({ kind: 'DEFER', reason: 'conflict-file' });
      const disjoint = await hook({ number: 9, labels: ['P1', 'factory:ready'], timestamp: '2026-11-01T00:00:00Z' });
      expect(disjoint.allow).toBe(true);
    } finally { store.close(); }
  }, 30_000);

  it('fails closed when running work cannot be read', async () => {
    const store = new BacklogStore({ path: ':memory:' });
    try {
      const hook = createBacklogAdmission({ repository: 'o/r', store, mode: 'enforce', config: { reservedHighPrioritySlots: 0 }, running: () => { throw new Error('registry unreadable'); } });
      const r = await hook({ number: 1, labels: ['P1', 'factory:ready'], timestamp: '2026-11-01T00:00:00Z' });
      expect(r).toMatchObject({ allow: false });
      expect(r.decision.reason).toBe('capacity-unknown');
    } finally { store.close(); }
  });
});
