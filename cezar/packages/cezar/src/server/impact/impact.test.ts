import { describe, expect, it } from 'vitest';
import { emptyManifest, isManifestStale, normalizeRepoPath, parseManifest, redactForScheduler, type ImpactManifest } from './manifest.ts';
import { analyzeOverlap, planBatch } from './overlap.ts';

const REPO = 'o/game';
const SHA = 'a'.repeat(40);

function manifest(issue: number, patch: Partial<Record<string, unknown>> = {}): ImpactManifest {
  const r = parseManifest({
    schemaVersion: 1, issue: { repository: REPO, number: issue }, repo: { repository: REPO, branch: 'dev', baseSha: SHA },
    manifestRevision: 1, generatedAt: '2026-11-03T00:00:00Z', mode: 'code-first', coverage: 'complete', ...patch,
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.manifest;
}
const file = (path: string, op = 'modify', extra: Record<string, unknown> = {}) => ({ path, op, confidence: 0.9, source: 'code-graph', ...extra });

describe('manifest schema', () => {
  it('normalises paths, rejects traversal/absolute paths and unknown versions', () => {
    expect(normalizeRepoPath('.\\Scripts//Player.cs')).toBe('Scripts/Player.cs');
    expect(normalizeRepoPath('../x')).toBeNull();
    expect(normalizeRepoPath('C:/x')).toBeNull();
    expect(normalizeRepoPath('/etc/passwd')).toBeNull();
    expect(normalizeRepoPath('a/*.cs')).toBeNull();
    expect(normalizeRepoPath('a/*.cs', true)).toBe('a/*.cs');
    expect(parseManifest({ schemaVersion: 2 }).ok).toBe(false);
    const bad = parseManifest({ schemaVersion: 1, issue: { repository: REPO, number: 1 }, repo: { repository: REPO, branch: 'dev', baseSha: SHA }, manifestRevision: 1, generatedAt: 'x', mode: 'code-first', coverage: 'complete', files: [file('../escape.cs')] });
    expect(bad).toMatchObject({ ok: false });
    const noFrom = parseManifest({ schemaVersion: 1, issue: { repository: REPO, number: 1 }, repo: { repository: REPO, branch: 'dev', baseSha: SHA }, manifestRevision: 1, generatedAt: 'x', mode: 'code-first', coverage: 'complete', files: [file('a.cs', 'rename')] });
    expect(noFrom.ok).toBe(false);
  });
  it('downgrades a "complete" claim that declares unknown zones', () => {
    expect(manifest(1, { unknownZones: [{ pattern: 'addons/**', reason: 'vendored' }] }).coverage).toBe('partial');
  });
  it('detects stale base SHA and treats unknown freshness as stale', () => {
    const m = manifest(1);
    expect(isManifestStale(m, SHA)).toBe(false);
    expect(isManifestStale(m, SHA.slice(0, 10))).toBe(false);
    expect(isManifestStale(m, 'b'.repeat(40))).toBe(true);
    expect(isManifestStale(m, null)).toBe(true);
  });
  it('redacts sensitive paths for the scheduler but keeps them matchable', () => {
    const m = manifest(1, { files: [file('licensed/Asset.pck'), file('src/a.cs')], sensitiveGlobs: ['licensed/**'] });
    const v = redactForScheduler(m);
    expect(v[0]!.path).toBeNull();
    expect(v[0]!.key).toMatch(/^redacted:/);
    expect(v[1]!.path).toBe('src/a.cs');
    expect(redactForScheduler(manifest(2, { files: [file('LICENSED/asset.pck')], sensitiveGlobs: ['licensed/**'] }))[0]!.key).toBe(v[0]!.key);
    const env = redactForScheduler(manifest(3, { files: [file('.env.local')] }));
    expect(env[0]!.path).toBeNull();
  });
});

describe('overlap analysis', () => {
  it('Godot scene + script: same scene is a file conflict, different ones are none', () => {
    const a = manifest(1, { files: [file('scenes/Main.tscn'), file('scripts/Player.gd')] });
    const b = manifest(2, { files: [file('Scenes/main.tscn')] }); // case-insensitive identity
    const c = manifest(3, { files: [file('scenes/Menu.tscn')] });
    expect(analyzeOverlap(a, b).level).toBe('file');
    expect(analyzeOverlap(a, c).level).toBe('none');
  });
  it('C# interface contract overlap beats file level and spans partial classes', () => {
    const contract = (files: string[]) => [{ id: 'IInventory', kind: 'interface', files, confidence: 0.8, source: 'code-graph' }];
    const a = manifest(1, { files: [file('Inv/Inventory.Part1.cs')], contracts: contract(['Inv/Inventory.Part1.cs']) });
    const b = manifest(2, { files: [file('Inv/Inventory.Part2.cs')], contracts: contract(['Inv/Inventory.Part2.cs']) });
    const r = analyzeOverlap(a, b);
    expect(r.level).toBe('contract');
    expect(r.findings.find((f) => f.kind === 'file')).toBeUndefined(); // distinct files, shared contract
  });
  it('rename collides with edits to the old path', () => {
    const a = manifest(1, { files: [file('new/Foo.cs', 'rename', { from: 'old/Foo.cs' })] });
    const b = manifest(2, { files: [file('old/foo.cs')] });
    expect(analyzeOverlap(a, b).level).toBe('file');
  });
  it('glob uncertainty lowers confidence but still conflicts', () => {
    const a = manifest(1, { files: [file('src/ui/**', 'modify', { glob: true })] });
    const b = manifest(2, { files: [file('src/ui/Button.cs')] });
    const r = analyzeOverlap(a, b);
    expect(r.level).toBe('file');
    expect(r.confidence).toBeLessThan(0.5);
    expect(analyzeOverlap(a, manifest(3, { files: [file('src/net/Socket.cs')] })).level).toBe('none');
  });
  it('mixed modules are warnings unless project policy elevates them', () => {
    const mod = (n: string) => [{ name: n, confidence: 0.7, source: 'agent-hypothesis' }];
    const a = manifest(1, { files: [file('a/x.cs')], modules: mod('Combat') });
    const b = manifest(2, { files: [file('b/y.cs')], modules: mod('combat') });
    expect(analyzeOverlap(a, b).level).toBe('module');
    expect(analyzeOverlap(a, b, { elevateModules: true, stalePenalty: 0.5 }).level).toBe('file');
  });
  it('missing documentation / unknown coverage never reads as conflict-free', () => {
    const known = manifest(1, { files: [file('a.cs')] });
    const empty = emptyManifest({ repository: REPO, number: 2 }, { repository: REPO, branch: 'dev', baseSha: SHA }, 'now');
    const r = analyzeOverlap(known, empty);
    expect(r.level).toBe('unknown');
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });
  it('declared unknown zones that cover the other side raise unknown', () => {
    const a = manifest(1, { files: [file('a.cs')], unknownZones: [{ pattern: 'addons/**', reason: 'vendored' }], coverage: 'complete' });
    const b = manifest(2, { files: [file('addons/x/y.gd')] });
    expect(analyzeOverlap(a, b).findings.some((f) => f.detail.includes('addons/**'))).toBe(true);
  });
  it('stale SHA reduces confidence and is reported', () => {
    const a = manifest(1, { files: [file('a.cs')] });
    const b = manifest(2, { files: [file('a.cs')] });
    const fresh = analyzeOverlap(a, b);
    const stale = analyzeOverlap(a, b, { elevateModules: false, stalePenalty: 0.5, currentBaseSha: { a: 'c'.repeat(40), b: SHA } });
    expect(stale.stale).toEqual({ a: true, b: false });
    expect(stale.confidence).toBeCloseTo(fresh.confidence * 0.5);
  });
  it('different repositories never conflict; sensitive paths are not leaked in findings', () => {
    const other = parseManifest({ schemaVersion: 1, issue: { repository: 'o/other', number: 9 }, repo: { repository: 'o/other', branch: 'dev', baseSha: SHA }, manifestRevision: 1, generatedAt: 'x', mode: 'code-first', coverage: 'complete', files: [file('a.cs')] });
    if (!other.ok) throw new Error('bad');
    expect(analyzeOverlap(manifest(1, { files: [file('a.cs')] }), other.manifest)).toMatchObject({ level: 'none', differentRepository: true });
    const a = manifest(1, { files: [file('secrets/k.txt')] });
    const b = manifest(2, { files: [file('secrets/k.txt')] });
    const r = analyzeOverlap(a, b);
    expect(r.level).toBe('file');
    expect(JSON.stringify(r.findings)).not.toContain('secrets/k.txt');
  });
});

describe('batch planning', () => {
  it('keeps priority order, defers overlaps, admits independent work, and treats unknown as conflict', () => {
    const items = [
      { id: 'P1-a', manifest: manifest(1, { files: [file('a.cs')] }) },
      { id: 'P1-b', manifest: manifest(2, { files: [file('b.cs')] }) },
      { id: 'P2-overlap', manifest: manifest(3, { files: [file('A.cs')] }) },
      { id: 'P2-unknown', manifest: emptyManifest({ repository: REPO, number: 4 }, { repository: REPO, branch: 'dev', baseSha: SHA }, 'now') },
    ];
    expect(planBatch(items)).toEqual({
      runTogether: ['P1-a', 'P1-b'],
      deferred: [{ id: 'P2-overlap', conflictsWith: 'P1-a', level: 'file' }, { id: 'P2-unknown', conflictsWith: 'P1-a', level: 'unknown' }],
    });
    expect(planBatch(items, undefined, 1).runTogether).toEqual(['P1-a']);
    // a lone unknown candidate still runs (nothing to conflict with): no starvation
    expect(planBatch([items[3]!]).runTogether).toEqual(['P2-unknown']);
  });
});
