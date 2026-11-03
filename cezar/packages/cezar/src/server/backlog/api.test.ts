import { afterEach, describe, expect, it } from 'vitest';
import { ObligationStore } from './integration-obligations.ts';
import { applyBacklogEdit, backlogEditSchema, backlogOverview, backlogRecommendation } from './api.ts';
import { BacklogStore } from './store.ts';
import { obligationKey } from './scheduling.ts';

const open: Array<{ close(): void }> = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const R = 'o/r';
const NOW = new Date('2026-11-03T12:00:00Z');
function setup() {
  const store = new BacklogStore({ path: ':memory:' });
  const obligations = new ObligationStore({ path: ':memory:' });
  open.push(store, obligations);
  store.ensureFromLabels(R, 1, { labels: ['P0', 'factory:needs-plan'], issueState: 'open' });
  store.ensureFromLabels(R, 2, { labels: ['P2', 'factory:ready'], issueState: 'open' });
  store.ensureFromLabels(R, 3, { labels: [], issueState: 'open' });
  return { store, obligations };
}

describe('backlog api', () => {
  it('returns lanes with scheduler-style reasons, merge debt and the audit', () => {
    const { store, obligations } = setup();
    obligations.ensure(R, 'o/r#2', 'o/r#9', obligationKey('o/r#2', 'o/r#9'), { kind: 'forced-overlap', detail: 'x' });
    store.update(R, 2, { scope: 'api' }, { actor: 'alice', reason: 'scoped' });
    const view = backlogOverview({ store, repository: R, obligations, now: NOW });
    const cards = Object.fromEntries(view.lanes.flatMap((l) => l.cards).map((c) => [c.id, c]));
    expect(cards['o/r#1']!.status).toMatchObject({ kind: 'not-dispatchable' });
    expect(cards['o/r#2']!.status.kind).toBe('dispatchable');
    expect(view.mergeDebt.open).toBe(1);
    expect(view.overrideAudit[0]).toMatchObject({ actor: 'alice', reason: 'scoped' });
    expect(view.conflicts).toBe(0);
  });
  it('recommends the Ready P2 over the unready P0 and lists the unprioritised issue for a human', () => {
    const { store } = setup();
    const rec = backlogRecommendation({ store, repository: R, now: NOW });
    expect(rec.next!.id).toBe('o/r#2');
    expect(rec.needsHuman.map((n) => n.id)).toEqual(['o/r#3']);
    expect(JSON.stringify(backlogRecommendation({ store, repository: R, now: NOW }))).toBe(JSON.stringify(rec)); // replay-stable
  });
  it('maps edit outcomes to stable statuses', () => {
    const { store } = setup();
    const rev = store.get(R, 3)!.revision;
    expect(applyBacklogEdit(store, R, 3, { action: 'update', expectedRevision: rev, fields: { basePriority: 'P1' } }, 'ui')).toMatchObject({ ok: true });
    expect(applyBacklogEdit(store, R, 3, { action: 'update', expectedRevision: rev, fields: { basePriority: 'P3' } }, 'ui')).toMatchObject({ ok: false, status: 409, code: 'stale_revision' });
    expect(applyBacklogEdit(store, R, 3, { action: 'update', expectedRevision: rev + 1, fields: { lane: 'Active' } }, 'ui')).toMatchObject({ ok: false, status: 422, code: 'invalid_transition' });
    expect(applyBacklogEdit(store, R, 99, { action: 'update', expectedRevision: 1, fields: {} }, 'ui')).toMatchObject({ ok: false, status: 404 });
    expect(applyBacklogEdit(store, R, 3, { action: 'undo', expectedRevision: rev + 1, fields: {} }, 'ui')).toMatchObject({ ok: true });
    expect(store.get(R, 3)!.basePriority).toBe('unset');
  });
  it('validates edit bodies strictly', () => {
    expect(backlogEditSchema.safeParse({ expectedRevision: 1, fields: { basePriority: 'P9' } }).success).toBe(false);
    expect(backlogEditSchema.safeParse({ expectedRevision: 1, fields: { bogus: 1 } }).success).toBe(false);
    expect(backlogEditSchema.safeParse({ fields: {} }).success).toBe(false);
    expect(backlogEditSchema.parse({ expectedRevision: 2, fields: { lane: 'Ready' } }).action).toBe('update');
  });
});
