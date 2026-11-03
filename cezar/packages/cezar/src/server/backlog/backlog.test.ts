import { afterEach, describe, expect, it } from 'vitest';
import { decodeBacklogMetadata, encodeBacklogMetadata, upsertBacklogMetadata } from './github-metadata.ts';
import { migrateFromLabels, priorityFromLabel } from './migrate.ts';
import { DEFAULT_FIELDS, isAllowedTransition, workflowEligibility } from './model.ts';
import { compareRank, isValidRank, rankBetween, spreadRanks } from './rank.ts';
import { BacklogError, BacklogStore } from './store.ts';
import { threeWayMerge } from './sync.ts';

const REPO = 'Owner/Repo';
const stores: BacklogStore[] = [];
function store(): BacklogStore { const s = new BacklogStore({ path: ':memory:' }); stores.push(s); return s; }
afterEach(() => { while (stores.length) stores.pop()!.close(); });
const human = { actor: 'alice' };

function seed(s: BacklogStore, n: number, labels: string[] = [], state: 'open' | 'closed' = 'open') {
  return s.ensureFromLabels(REPO, n, { labels, issueState: state }).record;
}

describe('rank', () => {
  it('always produces a strictly ordered, valid rank between neighbours', () => {
    let lo: string | null = null; const hi: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 200; i++) { lo = rankBetween(lo, hi); seen.push(lo); }
    expect([...seen].sort()).toEqual(seen);
    expect(new Set(seen).size).toBe(200);
    expect(seen.every(isValidRank)).toBe(true);
    let a = 'a', b = 'b';
    for (let i = 0; i < 50; i++) { const m = rankBetween(a, b); expect(m > a && m < b).toBe(true); b = m; }
    a = rankBetween(null, 'V');
    expect(a < 'V').toBe(true);
    expect(spreadRanks(5)).toHaveLength(5);
  });
  it('sorts unranked after ranked and rejects bad input', () => {
    expect(compareRank(null, 'a')).toBe(1);
    expect(compareRank('a', null)).toBe(-1);
    expect(() => rankBetween('b', 'a')).toThrow();
    expect(() => rankBetween('a0', null)).toThrow();
  });
});

describe('label migration', () => {
  it('maps priorities and lanes without losing information', () => {
    expect(priorityFromLabel('P1')).toBe('P1');
    expect(priorityFromLabel('priority:p3')).toBe('P3');
    expect(priorityFromLabel('priority:9')).toBe('P0');
    expect(priorityFromLabel('priority:0')).toBe('P4');
    expect(priorityFromLabel('bug')).toBeNull();
    const m = migrateFromLabels(['P2', 'priority:3', 'factory:needs-plan', 'factory:working'], 'open');
    expect(m.fields).toEqual({ basePriority: 'P1', lane: 'Active' });
    expect(m.warnings).toHaveLength(1);
    expect(migrateFromLabels(['factory:done'], 'open').fields.lane).toBe('Backlog');
    expect(migrateFromLabels([], 'closed').fields.lane).toBe('Done');
    expect(migrateFromLabels(['bug'], 'open').fields).toEqual({});
  });
  it('keeps unset explicit and is idempotent (never overwrites a later edit)', () => {
    const s = store();
    const first = s.ensureFromLabels(REPO, 1, { labels: ['bug'], issueState: 'open' });
    expect(first.created).toBe(true);
    expect(first.record.basePriority).toBe('unset');
    expect(first.record.backlogRank).toBeNull();
    s.update(REPO, 1, { basePriority: 'P3' }, human);
    const again = s.ensureFromLabels(REPO, 1, { labels: ['P0'], issueState: 'open' });
    expect(again.created).toBe(false);
    expect(again.record.basePriority).toBe('P3');
  });
});

describe('lanes and eligibility', () => {
  it('P0 in Refinement keeps importance but is not dispatchable; Ready P2 is', () => {
    const s = store();
    seed(s, 1, ['P0', 'factory:needs-plan']);
    seed(s, 2, ['P2', 'factory:ready']);
    const p0 = s.get(REPO, 1)!, p2 = s.get(REPO, 2)!;
    expect(p0.basePriority).toBe('P0');
    expect(workflowEligibility(p0).dispatchable).toBe(false);
    expect(workflowEligibility(p0).reasons[0]).toContain('Refinement');
    expect(workflowEligibility(p2).dispatchable).toBe(true);
    expect(s.list().map((r) => r.issueNumber)).toEqual([1, 2]); // order still reflects priority
  });
  it('rejects invalid transitions and Ready without priority; hold blocks dispatch', () => {
    const s = store();
    seed(s, 1);
    expect(isAllowedTransition('Done', 'Active')).toBe(false);
    expect(() => s.update(REPO, 1, { lane: 'Active' }, human)).toThrow(/not allowed/);
    expect(() => s.update(REPO, 1, { lane: 'Backlog' }, human)).not.toThrow();
    try { s.update(REPO, 1, { lane: 'Ready' }, human); throw new Error('expected'); }
    catch (e) { expect((e as BacklogError).code).toBe('not_ready'); }
    s.update(REPO, 1, { basePriority: 'P2', lane: 'Ready' }, human);
    const held = s.update(REPO, 1, { hold: true }, human);
    expect(workflowEligibility(held).reasons).toContain('issue is on hold');
    s.setIssueState(REPO, 1, { issueState: 'closed' });
    expect(workflowEligibility(s.get(REPO, 1)!).dispatchable).toBe(false);
  });
  it('validates fields and protects human-owned values from inference', () => {
    const s = store();
    seed(s, 1);
    expect(() => s.update(REPO, 1, { dueDate: 'tomorrow' }, human)).toThrow(/dueDate/);
    expect(() => s.update(REPO, 1, { backlogRank: 'a0' }, human)).toThrow(/backlogRank/);
    s.update(REPO, 1, { basePriority: 'P1' }, human);
    try { s.update(REPO, 1, { basePriority: 'P4' }, { actor: 'bot', source: 'inferred' }); throw new Error('expected'); }
    catch (e) { expect((e as BacklogError).code).toBe('human_owned'); }
    expect(s.update(REPO, 1, { effort: 3 }, { actor: 'bot', source: 'inferred' }).effort).toBe(3);
  });
});

describe('optimistic concurrency, audit and identity', () => {
  it('rejects stale revisions and audits every accepted change', () => {
    const s = store();
    const r = seed(s, 1);
    s.update(REPO, 1, { scope: 'a' }, { ...human, expectedRevision: r.revision, reason: 'scoping' });
    try { s.update(REPO, 1, { scope: 'b' }, { ...human, expectedRevision: r.revision }); throw new Error('expected'); }
    catch (e) { expect((e as BacklogError).code).toBe('stale_revision'); }
    const audit = s.audit(REPO, 1);
    expect(audit.map((a) => a.revision)).toEqual([1, 2]);
    expect(audit[1]).toMatchObject({ actor: 'alice', reason: 'scoping', before: { scope: null }, after: { scope: 'a' } });
    expect(s.update(REPO, 1, { scope: 'a' }, human).revision).toBe(2); // no-op does not bump
  });
  it('keeps cross-repo identities distinct and case-insensitive', () => {
    const s = store();
    s.ensureFromLabels('a/x', 7, { labels: ['P0'], issueState: 'open' });
    s.ensureFromLabels('b/x', 7, { labels: ['P4'], issueState: 'open' });
    expect(s.get('A/X', 7)!.basePriority).toBe('P0');
    expect(s.get('b/x', 7)!.basePriority).toBe('P4');
    expect(s.list({ repository: 'b/x' })).toHaveLength(1);
    expect(() => s.get('nope', 1)).toThrow(/invalid repository/);
  });
  it('orders equal-priority issues by rank and survives reopen', () => {
    const s = store();
    for (const n of [1, 2, 3]) { seed(s, n); s.update(REPO, n, { basePriority: 'P2' }, human); }
    s.placeBetween(REPO, 3, null, null, human);
    s.placeBetween(REPO, 1, 3, null, human);
    s.placeBetween(REPO, 2, 3, 1, human); // 3 < 2 < 1
    expect(s.list().map((r) => r.issueNumber)).toEqual([3, 2, 1]);
  });
  it('breaks rank collisions deterministically', () => {
    const s = store();
    for (const n of [1, 2, 3]) { seed(s, n); s.update(REPO, n, { backlogRank: 'M' }, human); }
    expect(s.normalizeRanks(REPO, human)).toBe(2);
    const order = s.list().map((r) => r.issueNumber);
    expect(order).toEqual([1, 2, 3]);
    expect(new Set(s.list().map((r) => r.backlogRank)).size).toBe(3);
  });
  it('persists across restarts', () => {
    const path = `${process.env.TEMP ?? '/tmp'}/backlog-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    const a = new BacklogStore({ path });
    a.ensureFromLabels(REPO, 1, { labels: ['P1'], issueState: 'open' });
    a.update(REPO, 1, { backlogRank: 'V' }, human);
    a.close();
    const b = new BacklogStore({ path }); stores.push(b);
    expect(b.get(REPO, 1)).toMatchObject({ basePriority: 'P1', backlogRank: 'V', revision: 2 });
  });
});

describe('github metadata', () => {
  const meta = { fields: { ...DEFAULT_FIELDS, basePriority: 'P1' as const, backlogRank: 'V' }, version: 3, origin: 'alice', writeId: 'w1', updatedAt: '2026-11-03T00:00:00Z' };
  it('round-trips and preserves human text', () => {
    const body = upsertBacklogMetadata('## Goal\ntext', meta);
    expect(decodeBacklogMetadata(body)).toEqual(meta);
    const replaced = upsertBacklogMetadata(body, { ...meta, version: 4 });
    expect(replaced.startsWith('## Goal\ntext')).toBe(true);
    expect(replaced.match(/factory-backlog/g)).toHaveLength(1);
    expect(decodeBacklogMetadata(replaced)!.version).toBe(4);
    expect(encodeBacklogMetadata(meta)).toContain('"basePriority":"P1"');
  });
  it('treats missing or corrupt blocks as absent', () => {
    expect(decodeBacklogMetadata('nothing')).toBeNull();
    expect(decodeBacklogMetadata('<!-- factory-backlog:v1 {oops} -->')).toBeNull();
    expect(decodeBacklogMetadata('<!-- factory-backlog:v1 {"fields":{"lane":"Ready","effort":-1},"version":1} -->')).toBeNull();
  });
});

describe('three-way merge', () => {
  it('classifies remote-only, local-only and conflicting edits', () => {
    const base = DEFAULT_FIELDS;
    const local = { ...base, scope: 'mine', owner: 'me' };
    const remote = { ...base, basePriority: 'P0' as const, owner: 'them' };
    const r = threeWayMerge(base, local, remote);
    expect(r.fromRemote).toEqual(['basePriority']);
    expect(r.toPush).toEqual(['scope']);
    expect(r.conflicts.map((c) => c.field)).toEqual(['owner']);
    expect(r.merged).toMatchObject({ basePriority: 'P0', scope: 'mine', owner: 'me' });
  });
});

describe('GitHub reconciliation', () => {
  function remoteBody(fields: Partial<typeof DEFAULT_FIELDS>, version: number, origin = 'bob', writeId = `w${version}`) {
    return upsertBacklogMetadata('body', { fields: { ...DEFAULT_FIELDS, ...fields }, version, origin, writeId, updatedAt: '2026-11-03T00:00:00Z' });
  }
  it('pushes local edits, ignores its own echo and rejects a stale push', () => {
    const s = store();
    seed(s, 1);
    s.update(REPO, 1, { basePriority: 'P1', backlogRank: 'V' }, human);
    const push = s.pendingPush(REPO, 1)!;
    expect(push.fields.sort()).toEqual(['backlogRank', 'basePriority']);
    const body = s.renderPush('issue text', push);
    s.markPushed(REPO, 1, push);
    expect(s.pendingPush(REPO, 1)).toBeNull();
    expect(s.applyRemote(REPO, 1, body)).toEqual({ outcome: 'echo' });
    expect(() => s.markPushed(REPO, 1, { ...push, expectedRemoteVersion: 0 })).toThrow(/re-sync/);
  });
  it('applies a remote-only edit and never loops it back', () => {
    const s = store();
    seed(s, 1);
    const out = s.applyRemote(REPO, 1, remoteBody({ basePriority: 'P0', lane: 'Backlog' }, 1));
    expect(out).toMatchObject({ outcome: 'merged', applied: expect.arrayContaining(['basePriority', 'lane']) });
    expect(s.get(REPO, 1)).toMatchObject({ basePriority: 'P0', lane: 'Backlog' });
    expect(s.get(REPO, 1)!.provenance.basePriority).toMatchObject({ source: 'human', actor: 'bob' });
    expect(s.pendingPush(REPO, 1)).toBeNull();
    expect(s.applyRemote(REPO, 1, remoteBody({ basePriority: 'P0', lane: 'Backlog' }, 1))).toEqual({ outcome: 'unchanged' });
  });
  it('surfaces concurrent edits as a conflict instead of dropping either side, then resolves explicitly', () => {
    const s = store();
    seed(s, 1);
    s.applyRemote(REPO, 1, remoteBody({}, 1));
    s.update(REPO, 1, { basePriority: 'P2' }, human);
    const out = s.applyRemote(REPO, 1, remoteBody({ basePriority: 'P0' }, 2));
    expect(out).toMatchObject({ outcome: 'merged', conflicts: ['basePriority'] });
    expect(s.get(REPO, 1)!.basePriority).toBe('P2'); // local value untouched
    expect(s.openConflicts(REPO, 1)).toHaveLength(1);
    s.applyRemote(REPO, 1, remoteBody({ basePriority: 'P0' }, 2, 'bob', 'other')); // replay does not duplicate
    expect(s.openConflicts(REPO, 1)).toHaveLength(1);
    expect(s.pendingPush(REPO, 1)).toBeNull(); // conflicted field is held back from pushing
    const kept = s.resolveConflict(REPO, 1, 'basePriority', 'remote', human);
    expect(kept.basePriority).toBe('P0');
    expect(s.openConflicts()).toHaveLength(0);
    expect(() => s.resolveConflict(REPO, 1, 'basePriority', 'remote', human)).toThrow(/no open conflict/);
  });
  it('keeping local re-queues it for push; outage replay converges', () => {
    const s = store();
    seed(s, 1);
    s.applyRemote(REPO, 1, remoteBody({}, 1));
    s.update(REPO, 1, { scope: 'mine' }, human); // offline local edit, queued
    expect(s.pendingPush(REPO, 1)!.fields).toEqual(['scope']);
    s.applyRemote(REPO, 1, remoteBody({ scope: 'theirs' }, 2)); // GitHub returns with a conflicting edit
    s.resolveConflict(REPO, 1, 'scope', 'local', human);
    const push = s.pendingPush(REPO, 1)!;
    expect(push).toMatchObject({ fields: ['scope'], expectedRemoteVersion: 2 });
    s.markPushed(REPO, 1, push);
    expect(s.pendingPush(REPO, 1)).toBeNull();
    expect(s.get(REPO, 1)!.scope).toBe('mine');
  });
  it('ignores remote metadata older than what it already folded in', () => {
    const s = store();
    seed(s, 1);
    s.applyRemote(REPO, 1, remoteBody({ basePriority: 'P1' }, 5));
    expect(s.applyRemote(REPO, 1, remoteBody({ basePriority: 'P4' }, 2))).toEqual({ outcome: 'unchanged' });
    expect(s.get(REPO, 1)!.basePriority).toBe('P1');
    expect(s.applyRemote(REPO, 1, 'no block')).toEqual({ outcome: 'no-remote-metadata' });
  });
});
