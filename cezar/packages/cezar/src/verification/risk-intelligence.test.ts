import { describe, expect, it } from 'vitest';
import {
  EVENT_KINDS, applyOverride, computeRisk, enforceFloor, minimumGuards, type ChangeRecord, type RiskEvent, type RiskInput,
} from './risk-intelligence.ts';

const NOW = new Date('2026-11-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
let n = 0;
const ev = (over: Partial<RiskEvent> & Pick<RiskEvent, 'files' | 'incident'>): RiskEvent => ({ id: `e${++n}`, repo: 'r1', kind: 'regression', at: daysAgo(5), confirmed: true, ...over });
const input = (over: Partial<RiskInput>): RiskInput => ({ repo: 'r1', now: NOW, events: [], changes: [], ...over });
const fileOf = (r: ReturnType<typeof computeRisk>, f: string) => r.files.find((x) => x.file === f)!;
const changes = (file: string, count: number, repo = 'r1'): ChangeRecord[] => Array.from({ length: count }, (_, i) => ({ repo, file, at: daysAgo(i % 60), commit: `${file}-${i}` }));

describe('stable high-change files are not penalised for churn alone', () => {
  it('churn raises concurrency, not likelihood or the overall level', () => {
    const r = computeRisk(input({ changes: changes('src/app/stable.ts', 80) }));
    const f = fileOf(r, 'src/app/stable.ts');
    expect(f.dimensions.concurrency).toBeGreaterThan(0.9);
    expect(f.dimensions.likelihood).toBe(0);
    expect(f.level).toBe('low');
    expect(f.reasons).toEqual([]);
  });
});

describe('repeated confirmed regressions raise risk; resolved ones decay without disappearing', () => {
  const two = [ev({ files: ['src/a/x.ts'], incident: 'i1' }), ev({ files: ['src/a/x.ts'], incident: 'i2' })];
  it('more distinct confirmed regressions mean more likelihood, and a single one is damped by the minimum evidence', () => {
    const one = fileOf(computeRisk(input({ events: [two[0]!] })), 'src/a/x.ts');
    const many = fileOf(computeRisk(input({ events: [...two, ev({ files: ['src/a/x.ts'], incident: 'i3' }), ev({ files: ['src/a/x.ts'], incident: 'i4' })] })), 'src/a/x.ts');
    const some = fileOf(computeRisk(input({ events: two })), 'src/a/x.ts');
    expect(one.dimensions.likelihood).toBeLessThan(some.dimensions.likelihood);
    expect(some.dimensions.likelihood).toBeLessThan(many.dimensions.likelihood);
    expect(one.reasons.join(' ')).toMatch(/only 1 distinct incident/);
    expect(many.level).toBe('high');
    expect(many.confidence).toBe('high');
  });

  it('time decay and resolution reduce the score but never to zero', () => {
    const fresh = fileOf(computeRisk(input({ events: two })), 'src/a/x.ts').dimensions.likelihood;
    const old = fileOf(computeRisk(input({ events: two.map((e) => ({ ...e, at: daysAgo(400) })) })), 'src/a/x.ts').dimensions.likelihood;
    const resolved = fileOf(computeRisk(input({ events: two.map((e) => ({ ...e, at: daysAgo(400), resolvedAt: daysAgo(380) })) })), 'src/a/x.ts').dimensions.likelihood;
    expect(old).toBeLessThan(fresh);
    expect(resolved).toBeLessThan(old);
    expect(resolved).toBeGreaterThan(0);
  });
});

describe('identical failures count once; attribution is not certainty', () => {
  it('the same failure across 100 reruns is one incident', () => {
    const reruns = Array.from({ length: 100 }, () => ev({ files: ['src/a/x.ts'], incident: 'flaky-test-42', kind: 'verification-failure', confirmed: false }));
    const once = computeRisk(input({ events: [reruns[0]!] }));
    const hundred = computeRisk(input({ events: reruns }));
    expect(fileOf(hundred, 'src/a/x.ts').dimensions).toEqual(fileOf(once, 'src/a/x.ts').dimensions);
    expect(fileOf(hundred, 'src/a/x.ts').evidenceCount).toBe(1);
  });

  it('an unattributed multi-file failure does not become a certain file-specific regression', () => {
    const files = ['src/a/one.ts', 'src/a/two.ts', 'src/a/three.ts'];
    const events = [ev({ files, incident: 'shared-1', confirmed: false }), ev({ files, incident: 'shared-2', confirmed: false })];
    const r = computeRisk(input({ events }));
    for (const f of files) {
      const x = fileOf(r, f);
      expect(x.dimensions.likelihood).toBeLessThan(0.4);
      expect(x.confidence).toBe('low');
      expect(x.reasons.join(' ')).toContain('shared across 3 files');
    }
    const caused = computeRisk(input({ events: events.map((e) => ({ ...e, confirmed: true, attributedTo: 'src/a/two.ts' })) }));
    expect(fileOf(caused, 'src/a/two.ts').dimensions.likelihood).toBeGreaterThan(fileOf(r, 'src/a/two.ts').dimensions.likelihood);
    expect(fileOf(caused, 'src/a/one.ts')?.dimensions.likelihood ?? 0).toBe(0);
  });
});

describe('contracts, modules and renames', () => {
  const contract = { id: 'public-api', repo: 'r1', files: ['src/api/types.ts', 'src/api/client.ts'], consumers: 12 };

  it('a changed public contract affects impact and concurrency independently of failure rate', () => {
    const base = computeRisk(input({ contracts: [contract] }));
    const changed = computeRisk(input({ contracts: [contract], changedNow: ['src/api/types.ts'] }));
    const before = fileOf(base, 'src/api/types.ts');
    const after = fileOf(changed, 'src/api/types.ts');
    expect(after.dimensions.impact).toBeGreaterThan(before.dimensions.impact);
    expect(after.dimensions.concurrency).toBeGreaterThan(before.dimensions.concurrency);
    expect(after.dimensions.likelihood).toBe(0);   // no incidents at all
    expect(after.reasons.join(' ')).toContain('12 consumer');
    expect(changed.contracts[0]).toMatchObject({ id: 'public-api', files: 2 });
  });

  it('rolls files up to modules and contracts deterministically', () => {
    const r = computeRisk(input({ events: [ev({ files: ['src/a/x.ts'], incident: 'i1' }), ev({ files: ['src/a/x.ts'], incident: 'i2' })], changes: changes('src/b/y.ts', 3) }));
    expect(r.modules.map((m) => m.id)).toEqual(['src/a', 'src/b']);
    expect(r.modules[0]!.files).toBe(1);
  });

  it('history follows a rename', () => {
    const events = [ev({ files: ['src/old/x.ts'], incident: 'i1' }), ev({ files: ['src/old/x.ts'], incident: 'i2' })];
    const r = computeRisk(input({ events, renames: [{ repo: 'r1', from: 'src/old/x.ts', to: 'src/new/x.ts' }] }));
    expect(fileOf(r, 'src/new/x.ts').evidenceCount).toBe(2);
    expect(r.files.find((f) => f.file === 'src/old/x.ts')).toBeUndefined();
  });
});

describe('isolation and determinism', () => {
  it('two repositories stay isolated and outputs are identical for fixed fixtures', () => {
    const events = [
      ev({ files: ['src/a/x.ts'], incident: 'i1', repo: 'r1' }), ev({ files: ['src/a/x.ts'], incident: 'i2', repo: 'r1' }),
      ev({ files: ['src/a/x.ts'], incident: 'j1', repo: 'r2' }), ev({ files: ['src/zzz/only-r2.ts'], incident: 'j2', repo: 'r2' }),
    ];
    const chg = [...changes('src/a/x.ts', 5, 'r1'), ...changes('src/zzz/only-r2.ts', 40, 'r2')];
    const r1 = computeRisk(input({ repo: 'r1', events, changes: chg }));
    const r2 = computeRisk(input({ repo: 'r2', events, changes: chg }));
    expect(r1.files.map((f) => f.file)).toEqual(['src/a/x.ts']);
    expect(r2.files.map((f) => f.file)).toEqual(['src/a/x.ts', 'src/zzz/only-r2.ts']);
    expect(fileOf(r1, 'src/a/x.ts').evidenceCount).toBe(2);
    expect(fileOf(r2, 'src/a/x.ts').evidenceCount).toBe(1);
    const again = computeRisk(input({ repo: 'r1', events: [...events].reverse(), changes: [...chg].reverse() }));
    expect(again).toEqual(r1);
    expect(r1.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(r1).toMatchObject({ dryRun: true, policyVersion: 'risk-policy-1', schemaVersion: 1 });
  });

  it('covers every event kind and keeps scores bounded', () => {
    const events = EVENT_KINDS.flatMap((kind, i) => Array.from({ length: 6 }, (_, j) => ev({ files: ['src/a/x.ts'], incident: `${kind}-${i}-${j}`, kind })));
    const f = fileOf(computeRisk(input({ events, changes: changes('src/a/x.ts', 500) })), 'src/a/x.ts');
    for (const v of Object.values(f.dimensions)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(f.overall).toBeLessThanOrEqual(1);
  });

  it('sensitivity changes where the levels fall, not the evidence', () => {
    const events = [ev({ files: ['src/a/x.ts'], incident: 'i1' }), ev({ files: ['src/a/x.ts'], incident: 'i2' })];
    const high = fileOf(computeRisk(input({ events, policy: { sensitivity: 'high' } })), 'src/a/x.ts');
    const low = fileOf(computeRisk(input({ events, policy: { sensitivity: 'low' } })), 'src/a/x.ts');
    expect(high.overall).toBe(low.overall);
    expect(['low', 'medium', 'high'].indexOf(high.level)).toBeGreaterThanOrEqual(['low', 'medium', 'high'].indexOf(low.level));
  });
});

describe('mandatory floors and guards are enforced without a model', () => {
  it('sensitive paths are high regardless of incident count', () => {
    const r = computeRisk(input({ changes: changes('svc/auth/login.ts', 1) }));
    const f = fileOf(r, 'svc/auth/login.ts');
    expect(f.evidenceCount).toBe(0);
    expect(f).toMatchObject({ level: 'high', floorLevel: 'high', floors: ['authentication'] });
    expect(f.reasons.join(' ')).toContain('regardless of history');
    for (const [path, id] of [['scripts/release/promote.py', 'release'], ['db/migrations/001.sql', 'migrations'], ['x/secrets/key.ts', 'secrets']] as const) {
      expect(fileOf(computeRisk(input({ changes: changes(path, 1) })), path).floors).toEqual([id]);
    }
  });

  it('a classifier suggestion can be raised by the floor but never lowered by it', () => {
    const f = fileOf(computeRisk(input({ changes: changes('svc/auth/login.ts', 1) })), 'svc/auth/login.ts');
    expect(enforceFloor('low', f)).toEqual({ level: 'high', floored: true, floors: ['authentication'] });
    expect(enforceFloor('high', f).floored).toBe(false);
    const plain = fileOf(computeRisk(input({ changes: changes('src/plain.ts', 1) })), 'src/plain.ts');
    expect(enforceFloor('medium', plain)).toMatchObject({ level: 'medium', floored: false });
  });

  it('overrides are audited, need a reason, and cannot go below a floor', () => {
    const auth = fileOf(computeRisk(input({ changes: changes('svc/auth/login.ts', 1) })), 'svc/auth/login.ts');
    const plain = fileOf(computeRisk(input({ events: [ev({ files: ['src/a/x.ts'], incident: 'i1' }), ev({ files: ['src/a/x.ts'], incident: 'i2' }), ev({ files: ['src/a/x.ts'], incident: 'i3' }), ev({ files: ['src/a/x.ts'], incident: 'i4' })] })), 'src/a/x.ts');
    const o = { file: 'x', level: 'low' as const, reason: 'generated code', actor: 'alice', at: NOW.toISOString() };
    expect(applyOverride(auth, o)).toMatchObject({ applied: false, level: 'high' });
    expect(applyOverride(auth, o).audit.refused).toContain('mandatory floor');
    expect(applyOverride(plain, o)).toMatchObject({ applied: true, level: 'low', audit: { before: 'high', actor: 'alice' } });
    expect(applyOverride(plain, { ...o, reason: ' ' })).toMatchObject({ applied: false });
  });

  it('derives minimum guards from the evidence alone', () => {
    const auth = fileOf(computeRisk(input({ changes: changes('svc/auth/login.ts', 1) })), 'svc/auth/login.ts');
    expect(minimumGuards(auth)).toEqual(['full-regression', 'independent-review', 'security-scan']);
    const api = fileOf(computeRisk(input({ contracts: [{ id: 'c', repo: 'r1', files: ['src/api/t.ts'], consumers: 15 }], changedNow: ['src/api/t.ts'] })), 'src/api/t.ts');
    expect(minimumGuards(api)).toContain('consumer-compatibility-check');
    const quiet = fileOf(computeRisk(input({ changes: changes('src/plain.ts', 1) })), 'src/plain.ts');
    expect(minimumGuards(quiet)).toEqual([]);
  });
});
