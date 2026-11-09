import { afterEach, describe, expect, it } from 'vitest';
import { parseManifest, type ImpactManifest } from '../impact/manifest.ts';
import { AdmissionLedger } from './admission-ledger.ts';
import { DEFAULT_FIELDS, type BacklogRecord } from './model.ts';
import { rankCandidates, recommend, type RankingInput } from './ranking.ts';
import { DEFAULT_SCHEDULING_CONFIG, decideOne, obligationKey, scheduleRound, type SchedulingContext } from './scheduling.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const REPO = 'o/r';
const SHA = 'a'.repeat(40);

function rec(n: number, patch: Partial<BacklogRecord> = {}): BacklogRecord {
  return { ...DEFAULT_FIELDS, repository: REPO, issueNumber: n, policyConstraints: [], issueState: 'open', archived: false, provenance: {}, revision: 1, updatedAt: '2026-11-01T00:00:00Z', ...patch };
}
const input = (n: number, patch: Partial<BacklogRecord> = {}, extra: Partial<RankingInput> = {}): RankingInput => ({ record: rec(n, patch), createdAt: '2026-11-01T12:00:00Z', ...extra });
const ready = (p: BacklogRecord['basePriority'], extra: Partial<BacklogRecord> = {}) => ({ basePriority: p, lane: 'Ready' as const, ...extra });

function manifest(n: number, files: string[], extra: Record<string, unknown> = {}): ImpactManifest {
  const r = parseManifest({ schemaVersion: 1, issue: { repository: REPO, number: n }, repo: { repository: REPO, branch: 'dev', baseSha: SHA }, manifestRevision: 1, generatedAt: 'x', mode: 'code-first', coverage: 'complete', files: files.map((path) => ({ path, op: 'modify', confidence: 0.9, source: 'code-graph' })), ...extra });
  if (!r.ok) throw new Error(r.errors.join(';'));
  return r.manifest;
}
function ctx(n: number, patch: Partial<BacklogRecord>, over: Partial<SchedulingContext> = {}, files: string[] | null = null): SchedulingContext {
  const [c] = rankCandidates([input(n, patch)], NOW);
  return { candidate: c!, dependency: { status: 'ready', blockers: [], graphRevision: 7 }, capacity: { status: 'available', revision: 'cap1' }, manifest: files ? manifest(n, files) : null, ...over };
}

describe('ranking', () => {
  it('keeps hard gates separate from the score: unready P0 is not dispatchable, Ready P2 is', () => {
    const ranked = rankCandidates([input(1, { basePriority: 'P0', lane: 'Refinement' }), input(2, ready('P2'))], NOW);
    expect(ranked.map((r) => r.id)).toEqual([`${REPO}#2`, `${REPO}#1`]);
    const p0 = ranked[1]!;
    expect(p0.eligible).toBe(false);
    expect(p0.gates[0]).toContain('Refinement');
    expect(p0.factors.find((f) => f.name === 'base-priority')!.points).toBe(1000);
    expect(recommend(ranked, NOW).next!.id).toBe(`${REPO}#2`);
  });
  it('orders equal-priority issues by rank, stably and deterministically', () => {
    const items = [input(3, ready('P2', { backlogRank: 'c' })), input(1, ready('P2', { backlogRank: 'a' })), input(2, ready('P2', { backlogRank: 'b' })), input(4, ready('P2'))];
    const a = rankCandidates(items, NOW).map((r) => r.record.issueNumber);
    const b = rankCandidates([...items].reverse(), NOW).map((r) => r.record.issueNumber);
    expect(a).toEqual([1, 2, 3, 4]);
    expect(b).toEqual(a);
  });
  it('aging prevents starvation within a tier but never leapfrogs a higher tier', () => {
    const old = input(1, ready('P3'), { createdAt: '2025-01-01T00:00:00Z' });
    const p2 = input(2, ready('P2'));
    const ranked = rankCandidates([old, p2], NOW);
    expect(ranked[0]!.record.issueNumber).toBe(2);
    expect(ranked[1]!.factors.find((f) => f.name === 'aging')!.points).toBe(150);
    const sameTierOld = rankCandidates([input(5, ready('P3')), input(6, ready('P3'), { createdAt: '2026-10-01T00:00:00Z' })], NOW);
    expect(sameTierOld[0]!.record.issueNumber).toBe(6);
  });
  it('expedite expires, unlocks are reported missing rather than zero, snooze gates', () => {
    const live = rankCandidates([input(1, ready('P4', { expedite: true }), { expediteUntil: '2026-11-04T00:00:00Z' })], NOW)[0]!;
    const lapsed = rankCandidates([input(1, ready('P4', { expedite: true }), { expediteUntil: '2026-11-02T00:00:00Z' })], NOW)[0]!;
    expect(live.score).toBeGreaterThan(lapsed.score + 400);
    expect(live.missingInputs).toContain('dependency-unlock');
    const unlock = rankCandidates([input(1, ready('P2'), { unlocks: 3, criticalPathSteps: 1 })], NOW)[0]!;
    expect(unlock.factors.find((f) => f.name === 'unlock')!.points).toBe(55);
    const snoozed = rankCandidates([input(1, ready('P2'), { snoozeUntil: '2026-11-10T00:00:00Z' })], NOW)[0]!;
    expect(snoozed.eligible).toBe(false);
  });
  it('uses neutral P2 scoring for unset priority without creating a human gate', () => {
    const items = [input(1, { lane: 'Inbox' }), input(2, ready('P1'))];
    expect(JSON.stringify(rankCandidates(items, NOW))).toBe(JSON.stringify(rankCandidates(items, NOW)));
    const ranked = rankCandidates(items, NOW);
    expect(ranked.find((r) => r.record.issueNumber === 1)!.factors.find((f) => f.name === 'base-priority')!.points).toBe(600);
    expect(recommend(ranked, NOW).needsHuman).toEqual([]);
  });
});

describe('scheduling decisions', () => {
  const config = { ...DEFAULT_SCHEDULING_CONFIG, enforce: true, reservedHighPrioritySlots: 0, maxPerRepository: 5 };
  it('hard-blocked P0 does not steal the executor from Ready P2; blockers have their own status', () => {
    const blocked = ctx(1, ready('P0'), { dependency: { status: 'blocked', blockers: ['#9'], graphRevision: 7 } });
    const p2 = ctx(2, ready('P2'));
    const round = scheduleRound([blocked, p2], [], config);
    expect(round.decisions[0]).toMatchObject({ kind: 'DEFER', reason: 'blocked-dependency' });
    expect(round.decisions[1]).toMatchObject({ kind: 'RUN', reason: 'ok' });
    expect(round.admitted).toEqual([`${REPO}#2`]);
  });
  it('runs disjoint Ready tasks concurrently as a batch and serializes shared files', () => {
    const a = ctx(1, ready('P1'), {}, ['a.cs']);
    const b = ctx(2, ready('P2'), {}, ['b.cs']);
    const c = ctx(3, ready('P2'), {}, ['A.cs']);
    const round = scheduleRound([a, b, c], [], config);
    expect(round.decisions.map((d) => d.kind)).toEqual(['BATCH', 'BATCH', 'DEFER']);
    expect(round.decisions[0]!.batchWith).toEqual([`${REPO}#2`]);
    expect(round.decisions[2]).toMatchObject({ reason: 'conflict-file', conflict: { level: 'file' } });
  });
  it('treats missing or stale manifests as unknown conflict, module overlap as coordination', () => {
    const running = [{ id: `${REPO}#9`, repository: REPO, manifest: manifest(9, ['x.cs']) }];
    expect(decideOne(ctx(1, ready('P2')), running, config)).toMatchObject({ kind: 'DEFER', reason: 'conflict-unknown' });
    expect(decideOne(ctx(1, ready('P2'), { manifestStale: true }, ['y.cs']), running, config)).toMatchObject({ reason: 'conflict-unknown' });
    const modRunning = [{ id: `${REPO}#9`, repository: REPO, manifest: manifest(9, ['x.cs'], { modules: [{ name: 'Combat', confidence: 0.7, source: 'human' }] }) }];
    const mine = ctx(2, ready('P2'));
    mine.manifest = manifest(2, ['y.cs'], { modules: [{ name: 'combat', confidence: 0.7, source: 'human' }] });
    expect(decideOne(mine, modRunning, config)).toMatchObject({ kind: 'COORDINATE', reason: 'module-overlap' });
  });
  it('audited forced overlap yields INTEGRATE with an idempotent obligation key', () => {
    const running = [{ id: `${REPO}#9`, repository: REPO, manifest: manifest(9, ['x.cs']) }];
    const forced = ctx(1, ready('P1'), { forceOverlap: { actor: 'alice', reason: 'deadline' } }, ['x.cs']);
    const d = decideOne(forced, running, config);
    expect(d).toMatchObject({ kind: 'INTEGRATE', reason: 'forced-overlap', obligationKey: obligationKey(`${REPO}#1`, `${REPO}#9`) });
    expect(obligationKey('a', 'b')).toBe(obligationKey('b', 'a'));
  });
  it('gives quota, capacity-unknown, ownership, approval and WIP distinct statuses', () => {
    expect(decideOne(ctx(1, ready('P2'), { capacity: { status: 'exhausted', resetAt: '2026-11-04T00:00:00Z' } }), [], config).reason).toBe('quota-exhausted');
    expect(decideOne(ctx(1, ready('P2'), { capacity: { status: 'unknown' } }), [], config).reason).toBe('capacity-unknown');
    expect(decideOne(ctx(1, ready('P2'), { ownedBy: 'dev-window' }), [], config).reason).toBe('owned-elsewhere');
    expect(decideOne(ctx(1, ready('P2'), { approvalRequired: true }), [], config).reason).toBe('approval-required');
    expect(decideOne(ctx(1, ready('P2'), { dependency: { status: 'unknown', blockers: [], graphRevision: 1 } }), [], config).reason).toBe('unknown-dependency');
    expect(decideOne(ctx(1, ready('P2', { hold: true })), [], config).reason).toBe('on-hold');
    expect(decideOne(ctx(1, { lane: 'Refinement', basePriority: 'P0' }), [], config).reason).toBe('not-ready');
    const full = Array.from({ length: 3 }, (_, i) => ({ id: `${REPO}#${20 + i}`, repository: 'other/repo' }));
    expect(decideOne(ctx(1, ready('P2')), full, config).reason).toBe('wip-limit');
  });
  it('reserves capacity for high priority work and shadows by default', () => {
    const reserve = { ...config, reservedHighPrioritySlots: 1, maxParallel: 2 };
    const one = [{ id: 'other/repo#1', repository: 'other/repo' }];
    expect(decideOne(ctx(1, ready('P3')), one, reserve).reason).toBe('wip-reserved');
    expect(decideOne(ctx(2, ready('P0')), one, reserve).kind).toBe('RUN');
    const shadow = decideOne(ctx(3, ready('P0')), [], DEFAULT_SCHEDULING_CONFIG);
    expect(shadow.shadow).toBe(true);
  });
  it('is replay-stable: identical inputs give identical decision keys', () => {
    const a = decideOne(ctx(1, ready('P2'), {}, ['a.cs']), [], config);
    const b = decideOne(ctx(1, ready('P2'), {}, ['a.cs']), [], config);
    expect(a).toEqual(b);
    expect(decideOne(ctx(1, ready('P2'), { dependency: { status: 'ready', blockers: [], graphRevision: 8 } }, ['a.cs']), [], config).decisionKey).not.toBe(a.decisionKey);
  });
});

describe('admission ledger', () => {
  const ledgers: AdmissionLedger[] = [];
  afterEach(() => { while (ledgers.length) ledgers.pop()!.close(); });
  const open = (path: string) => { const l = new AdmissionLedger({ path }); ledgers.push(l); return l; };

  it('never double-dispatches or double-reserves across two scheduler processes', () => {
    const path = `${process.env.TEMP ?? '/tmp'}/admission-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    const p1 = open(path), p2 = open(path);
    const opts = { maxActive: 2, ttlMs: 60_000, now: 1_000 };
    const first = p1.reserve('o/r#1', 'sched-A', 'k', opts);
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(p2.reserve('o/r#1', 'sched-B', 'k', opts)).toMatchObject({ ok: false, reason: 'held', holder: 'sched-A' });
    expect(p1.reserve('o/r#1', 'sched-A', 'k', opts)).toMatchObject({ ok: true, replay: true });
    expect(p2.reserve('o/r#2', 'sched-B', 'k', opts)).toMatchObject({ ok: true });
    expect(p1.reserve('o/r#3', 'sched-A', 'k', opts)).toMatchObject({ ok: false, reason: 'capacity' });
    expect(p1.active(1_000)).toHaveLength(2);
  });
  it('expires crashed holders, releases only with the right token', () => {
    const l = open(':memory:');
    const r = l.reserve('o/r#1', 'A', 'k', { maxActive: 1, ttlMs: 1_000, now: 0 });
    if (!r.ok) throw new Error('expected reservation');
    expect(l.release('o/r#1', 'wrong')).toBe(false);
    expect(l.reserve('o/r#2', 'B', 'k', { maxActive: 1, ttlMs: 1_000, now: 500 })).toMatchObject({ ok: false, reason: 'capacity' });
    expect(l.reserve('o/r#1', 'B', 'k', { maxActive: 1, ttlMs: 1_000, now: 2_000 })).toMatchObject({ ok: true, replay: false }); // A's lease lapsed
    expect(l.release('o/r#1', r.token)).toBe(false); // stale token cannot release B's lease
  });
});
