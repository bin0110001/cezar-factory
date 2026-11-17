import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verificationFindingKindSchema } from '@open-mercato/cezar-contract';
import { ingestCheckFindings, type CheckIngestInput } from './check-finding-ingest.ts';
import { baselineFromFindings, type RunFacts } from './disposition.ts';
import { FindingAuditLog } from './finding-ingest.ts';
import { FileFindingLedgerStore } from './finding-ledger.ts';
import { FINGERPRINT_STRATEGIES } from './fingerprint.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'check-ingest-'));
  roots.push(dir);
  return { store: FileFindingLedgerStore.open(dir, 'p', { now: () => new Date('2026-11-10T00:00:00.000Z') }), audit: new FindingAuditLog(dir, 'p') };
}

const fp = (n: number) => n.toString(16).padStart(64, '0');
const SHA = 'c'.repeat(40);
const run = (over: Partial<RunFacts> = {}): RunFacts => ({ status: 'warn', execution: 'completed', selectionComplete: true, coverageComplete: true, evidenceFresh: true, envFingerprint: 'env-1', baseSha: 'b'.repeat(40), policyVersion: 'p1', actor: 'ci', ...over });
const baseline = (n: number) => baselineFromFindings(Array.from({ length: n }, (_, i) => ({ fingerprint: fp(i + 1), severity: 'low' })), { source: 'integration', sha: 'a'.repeat(40), envFingerprint: 'env-1', at: '2026-11-01T00:00:00Z' });
let seq = 0;
const input = (n: number, over: Partial<CheckIngestInput> = {}): CheckIngestInput => ({
  projectId: 'p', verificationId: `v${++seq}`, runId: 'run-1', checkId: 'dependency-scan', commitSha: SHA, environment: { os: 'linux' }, observedAt: `2026-11-10T00:0${Math.min(seq, 9)}:00.000Z`,
  findings: Array.from({ length: n }, (_, i) => ({ fingerprint: fp(i + 1), severity: 'low', diagnostics: [{ code: 'CVE-2021-0001', message: `finding ${i + 1}`, file: 'package-lock.json', line: 3 }] })),
  baseline: baseline(42), run: run(), ...over,
});

describe('ledger widening', () => {
  it('check-finding is a first-class kind with a registered fingerprint strategy', () => {
    expect(verificationFindingKindSchema.options).toContain('check-finding');
    expect(FINGERPRINT_STRATEGIES['check-finding']).toEqual({ id: 'cezar.verification.check-finding', version: 1, kinds: ['check-finding'] });
  });
});

describe('persisting check findings in the existing ledger', () => {
  it('stores findings, occurrences and episodes and records one disposition event', () => {
    const { store, audit } = setup();
    const o = ingestCheckFindings(store, audit, input(2, { baseline: baseline(0) }));
    expect(o.opened).toEqual([fp(1), fp(2)]);
    const snap = store.snapshot();
    expect(snap.findings.map((f) => f.kind)).toEqual(['check-finding', 'check-finding']);
    expect(snap.occurrences).toHaveLength(2);
    expect(snap.episodes.filter((e) => e.status === 'open')).toHaveLength(2);
    expect(audit.history().filter((e) => e.type === 'disposition-recorded')).toHaveLength(1);
    expect(audit.verifyReplay()).toBe(true);
  });

  it('42 known warnings then 39: three episodes resolve, 39 stay known, nothing else changes', () => {
    const { store, audit } = setup();
    ingestCheckFindings(store, audit, input(42));
    expect(store.snapshot().episodes.filter((e) => e.status === 'open')).toHaveLength(42);
    const second = ingestCheckFindings(store, audit, input(39));
    expect(second.dispositions.summary).toMatchObject({ known: 39, resolved: 3 });
    expect(second.resolved).toEqual([fp(40), fp(41), fp(42)]);
    const open = store.snapshot().episodes.filter((e) => e.status === 'open');
    expect(open).toHaveLength(39);
    expect(audit.history().filter((e) => e.type === 'episode-resolved')).toHaveLength(3);
  });

  it('a feature-branch baseline cannot turn a new failure into a known one in the ledger', () => {
    const { store, audit } = setup();
    const untrusted = { ...baseline(5), source: 'feature-branch' };
    const o = ingestCheckFindings(store, audit, input(3, { baseline: untrusted }));
    expect(o.dispositions.run).toBe('untrusted-baseline');
    expect(o.dispositions.summary).toMatchObject({ new: 3, known: 0 });
  });

  it('a crashed runner, missing suite, stale evidence and a changed environment resolve nothing', () => {
    const { store, audit } = setup();
    ingestCheckFindings(store, audit, input(3, { baseline: baseline(3) }));
    const bad: Array<[string, Partial<RunFacts>]> = [['infra-failure', { execution: 'failed' }], ['untested', { selectionComplete: false }], ['unknown', { evidenceFresh: false }], ['environment-changed', { envFingerprint: 'env-9' }]];
    for (const [expected, facts] of bad) {
      const o = ingestCheckFindings(store, audit, input(0, { baseline: baseline(3), run: run(facts) }));
      expect(o.dispositions.run).toBe(expected);
      expect(o.resolved).toEqual([]);
      expect(store.snapshot().episodes.filter((e) => e.status === 'open')).toHaveLength(3);
    }
  });

  it('replaying the same run is a no-op that writes nothing', () => {
    const { store, audit } = setup();
    const i = input(4, { baseline: baseline(0) });
    const first = ingestCheckFindings(store, audit, i);
    const counts = () => ({ f: store.snapshot().findings.length, o: store.snapshot().occurrences.length, e: store.snapshot().episodes.length, a: audit.history().length });
    const before = counts();
    const again = ingestCheckFindings(store, audit, i);
    expect(again.replayed).toBe(true);
    expect(counts()).toEqual(before);
    expect(again.dispositions.digest).toBe(first.dispositions.digest);
    const empty = input(0, { baseline: baseline(0) });
    ingestCheckFindings(store, audit, empty);
    const n = audit.history().length;
    expect(ingestCheckFindings(store, audit, empty).replayed).toBe(true);
    expect(audit.history().length).toBe(n);
  });

  it('a resolved finding that returns is reopened', () => {
    const { store, audit } = setup();
    ingestCheckFindings(store, audit, input(1, { baseline: baseline(1) }));
    ingestCheckFindings(store, audit, input(0, { baseline: baseline(1) }));
    expect(store.snapshot().episodes.filter((e) => e.status === 'open')).toHaveLength(0);
    const back = ingestCheckFindings(store, audit, input(1, { baseline: baseline(1) }));
    expect(back.dispositions.summary.reopened).toBe(1);
    expect(store.snapshot().episodes).toHaveLength(2);
  });

  it('refuses a result for another project', () => {
    const { store, audit } = setup();
    expect(() => ingestCheckFindings(store, audit, input(1, { projectId: 'other' }))).toThrow(/project id/);
  });
});
