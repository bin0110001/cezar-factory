import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  grantWaiver, loadDispositionPolicy, normalizeDispositions, recordDispositions, resolveTrustedBaseline,
  type DispositionPolicy, type FindingObservation, type RunObservation, type TrustedBaselineCandidate,
} from './disposition.ts';
import { FindingAuditLog, replayAudit } from './finding-ingest.ts';
import { FileFindingLedgerStore } from './finding-ledger.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dir = () => { const root = mkdtempSync(join(tmpdir(), 'disposition-')); roots.push(root); return join(root, '.ai', 'cezar'); };

const policy: DispositionPolicy = {
  version: 1, integrationBranches: ['dev'], environmentKeys: ['platform', 'arch'],
  maxBaselineAgeDays: 30, waiverMaxTtlDays: 14, approvers: ['maintainer'],
};
const fp = (n: number) => n.toString(16).padStart(64, '0');
const finding = (n: number, checkId = 'unit', count = 1): FindingObservation => ({ fingerprint: fp(n), checkId, count });
const env = { platform: 'linux', arch: 'x64' };
const baseline = (findings: FindingObservation[], over: Partial<TrustedBaselineCandidate> = {}): TrustedBaselineCandidate => ({
  id: 'base-1', branch: 'dev', commitSha: 'a'.repeat(40), source: 'integration', environment: env,
  suites: ['unit'], observedAt: '2026-11-10T00:00:00.000Z', findings, ...over,
});
const run = (findings: FindingObservation[], over: Partial<RunObservation> = {}): RunObservation => ({
  projectId: 'p', runId: 'run-1', branch: 'feature/x', commitSha: 'b'.repeat(40), author: 'agent', environment: env,
  requiredSuites: ['unit'], executedSuites: ['unit'], selectionComplete: true, runStatus: 'completed',
  observedAt: '2026-11-12T00:00:00.000Z', findings, ...over,
});
const range = (n: number) => Array.from({ length: n }, (_, i) => finding(i + 1));
const classes = (r: ReturnType<typeof normalizeDispositions>) => r.dispositions.map((d) => d.disposition);

describe('normalizeDispositions', () => {
  it('compares 39 of 42 known warnings as known/unchanged with 3 resolved and none new', () => {
    const result = normalizeDispositions({ run: run(range(39)), baselines: [baseline(range(42))], policy });
    const count = (c: string) => classes(result).filter((x) => x === c).length;
    expect(count('known')).toBe(39);
    expect(count('resolved')).toBe(3);
    expect(count('new')).toBe(0);
    expect(result.status).toBe('comparable');
    expect(result.passable).toBe(true);
  });

  it('classifies new, worsened and reopened', () => {
    const result = normalizeDispositions({
      run: run([finding(1, 'unit', 3), finding(2), finding(3)]),
      baselines: [baseline([finding(1, 'unit', 1)])], resolvedFingerprints: [fp(3)], policy,
    });
    const by = Object.fromEntries(result.dispositions.map((d) => [d.fingerprint, d.disposition]));
    expect(by[fp(1)]).toBe('worsened');
    expect(by[fp(2)]).toBe('new');
    expect(by[fp(3)]).toBe('reopened');
    expect(result.passable).toBe(false);
  });

  it('keeps a feature-branch rerun of a baseline-absent failure new, never known', () => {
    const featureRerun = baseline([finding(9)], { id: 'feat', branch: 'feature/x', commitSha: 'c'.repeat(40) });
    const result = normalizeDispositions({ run: run([finding(9)]), baselines: [baseline([]), featureRerun], policy });
    expect(result.rejectedBaselines.map((r) => r.id)).toContain('feat');
    expect(classes(result)).toEqual(['new']);
  });

  it('yields unknown with no trusted baseline', () => {
    const result = normalizeDispositions({ run: run([]), baselines: [baseline([], { branch: 'feature/x' })], policy });
    expect(result.status).toBe('unknown');
    expect(result.passable).toBe(false);
  });

  it('yields unknown when the environment changed', () => {
    const result = normalizeDispositions({ run: run(range(2), { environment: { platform: 'win32', arch: 'x64' } }), baselines: [baseline(range(2))], policy });
    expect(result.status).toBe('unknown');
    expect(classes(result)).not.toContain('known');
    expect(result.passable).toBe(false);
  });

  it('yields unknown for stale baseline evidence', () => {
    const stale = baseline(range(2), { observedAt: '2026-09-01T00:00:00.000Z' });
    const result = normalizeDispositions({ run: run(range(2)), baselines: [stale], policy });
    expect(result.status).toBe('unknown');
    expect(result.rejectedBaselines[0]?.reason).toMatch(/stale/);
  });

  it('never resolves or passes with a missing suite or incomplete selection', () => {
    const missing = normalizeDispositions({ run: run([], { executedSuites: [] }), baselines: [baseline(range(2))], policy });
    expect(missing.status).toBe('unknown');
    expect(classes(missing)).toContain('untested');
    expect(classes(missing)).not.toContain('resolved');
    expect(missing.passable).toBe(false);
    const partial = normalizeDispositions({ run: run([], { selectionComplete: false }), baselines: [baseline(range(2))], policy });
    expect(classes(partial)).not.toContain('resolved');
    expect(partial.passable).toBe(false);
  });

  it('yields infra-failure for a runner crash even with an empty finding list', () => {
    for (const runStatus of ['crashed', 'timeout', 'cancelled'] as const) {
      const result = normalizeDispositions({ run: run([], { runStatus }), baselines: [baseline(range(2))], policy });
      expect(result.status).toBe('infra-failure');
      expect(classes(result)).toEqual(['infra-failure']);
      expect(result.passable).toBe(false);
    }
  });

  it('does not treat known as waived; a valid waiver covers only a scoped, unexpired, independent case', () => {
    const waiver = (over = {}) => ({
      id: 'w1', projectId: 'p', fingerprint: fp(5), branches: ['feature/x'], reason: 'tracked', grantedBy: 'maintainer',
      grantedAt: '2026-11-11T00:00:00.000Z', expiresAt: '2026-11-20T00:00:00.000Z', policyVersion: 1, ...over,
    });
    const input = (waivers: ReturnType<typeof waiver>[], over: Partial<RunObservation> = {}) =>
      normalizeDispositions({ run: run([finding(5), finding(1)], over), baselines: [baseline([finding(1)])], waivers, policy });
    const known = input([]).dispositions.find((d) => d.fingerprint === fp(1))!;
    expect(known.disposition).toBe('known');
    expect(known.waiverId).toBeNull();
    const waived = input([waiver()]).dispositions.find((d) => d.fingerprint === fp(5))!;
    expect(waived).toMatchObject({ disposition: 'new', decision: 'non-blocking', waiverId: 'w1' });
    expect(input([waiver({ expiresAt: '2026-11-11T12:00:00.000Z' })]).passable).toBe(false);
    expect(input([waiver({ branches: ['other'] })]).passable).toBe(false);
    expect(input([waiver({ grantedBy: 'agent' })]).passable).toBe(false);
    expect(input([waiver({ grantedBy: 'maintainer' })], { author: 'maintainer' }).passable).toBe(false);
  });

  it('is deterministic regardless of input order', () => {
    const a = normalizeDispositions({ run: run(range(5)), baselines: [baseline(range(7))], policy });
    const b = normalizeDispositions({ run: run([...range(5)].reverse()), baselines: [baseline([...range(7)].reverse())], policy });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('resolveTrustedBaseline', () => {
  it('rejects unapproved or self-approved evidence and accepts independent approved evidence', () => {
    const r = run([]);
    const mk = (approvedBy?: string) => baseline([], { id: `ev-${approvedBy}`, branch: 'feature/x', source: 'approved-evidence', approvedBy });
    expect(resolveTrustedBaseline([mk('agent'), mk(undefined)], r, policy).baseline).toBeNull();
    expect(resolveTrustedBaseline([mk('maintainer')], r, policy).baseline?.id).toBe('ev-maintainer');
    expect(resolveTrustedBaseline([mk('maintainer')], run([], { author: 'maintainer' }), policy).baseline).toBeNull();
  });
});

describe('persistence, waivers and replay', () => {
  it('stores dispositions in the ledger, audits them, and replays identically', () => {
    const d = dir();
    const store = FileFindingLedgerStore.open(d, 'p');
    const audit = new FindingAuditLog(d, 'p');
    const result = normalizeDispositions({ run: run(range(3)), baselines: [baseline(range(4))], policy });
    recordDispositions(store, audit, result, policy);
    recordDispositions(store, audit, result, policy); // idempotent
    expect(store.dispositionsForRun('run-1')).toEqual(result.dispositions);
    expect(audit.history()).toHaveLength(1);
    expect(audit.state().dispositionRuns['run-1']?.counts).toEqual({ known: 3, resolved: 1 });
    expect(audit.verifyReplay()).toBe(true);
    const again = normalizeDispositions({ run: run(range(3)), baselines: [baseline(range(4))], policy });
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
    expect(JSON.stringify(replayAudit('p', audit.history()))).toBe(JSON.stringify(audit.state()));
  });

  it('loads older ledger files without disposition arrays', () => {
    const d = dir();
    const first = FileFindingLedgerStore.open(d, 'p');
    first.createFinding({ fingerprint: fp(1), kind: 'test-failure' as never, strategyId: 's', strategyVersion: 1, at: '2026-11-10T00:00:00.000Z' });
    const path = join(d, 'verification-ledger.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    delete raw.dispositions; delete raw.waivers;
    writeFileSync(path, JSON.stringify(raw));
    const snap = FileFindingLedgerStore.open(d, 'p').snapshot();
    expect(snap.dispositions).toEqual([]);
    expect(snap.waivers).toEqual([]);
    expect(snap.findings).toHaveLength(1);
  });

  it('grants a waiver only with an independent permitted authority, bounded ttl and explicit scope', () => {
    const d = dir();
    const store = FileFindingLedgerStore.open(d, 'p');
    const audit = new FindingAuditLog(d, 'p');
    const req = { id: 'w1', fingerprint: fp(1), branches: ['feature/x'], reason: 'tracked', requestedBy: 'agent', grantedBy: 'maintainer', grantedAt: '2026-11-11T00:00:00.000Z', expiresAt: '2026-11-15T00:00:00.000Z' };
    expect(() => grantWaiver(store, audit, { ...req, grantedBy: 'agent' }, policy)).toThrow(/permitted approver/);
    expect(() => grantWaiver(store, audit, { ...req, requestedBy: 'maintainer' }, policy)).toThrow(/independent/);
    expect(() => grantWaiver(store, audit, { ...req, expiresAt: '2027-01-01T00:00:00.000Z' }, policy)).toThrow(/ttl/);
    expect(() => grantWaiver(store, audit, { ...req, branches: ['*'] }, policy)).toThrow(/wildcard/);
    expect(() => grantWaiver(store, audit, { ...req, expiresAt: req.grantedAt }, policy)).toThrow();
    grantWaiver(store, audit, req, policy);
    expect(store.snapshot().waivers).toHaveLength(1);
    expect(audit.state().waivers.w1?.grantedBy).toBe('maintainer');
  });

  it('parses the repository policy files', () => {
    const root = join(__dirname, '..', '..', '..', '..', '..');
    const verification = JSON.parse(readFileSync(join(root, 'policies', 'verification.json'), 'utf8'));
    const promotion = JSON.parse(readFileSync(join(root, 'policies', 'baseline-promotion.json'), 'utf8'));
    expect(loadDispositionPolicy(verification, promotion).approvers).toEqual(promotion.permittedApprovers);
  });
});
