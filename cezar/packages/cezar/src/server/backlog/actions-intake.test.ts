import { afterEach, describe, expect, it } from 'vitest';
import { evaluateReadiness, findDuplicateCandidates } from './intake.ts';
import { createBacklogAdmission } from './admission-hook.ts';
import { BacklogStore } from './store.ts';

const stores: BacklogStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
const store = () => { const s = new BacklogStore({ path: ':memory:' }); stores.push(s); return s; };
const R = 'o/r';
const human = { actor: 'alice' };
const seed = (s: BacklogStore, n: number, labels: string[] = []) => s.ensureFromLabels(R, n, { labels, issueState: 'open' });

describe('reprioritisation actions', () => {
  it('undoes the latest human edit only while it is still the latest change', () => {
    const s = store();
    seed(s, 1, ['P2']);
    s.update(R, 1, { basePriority: 'P0', scope: 'x' }, human);
    expect(s.undoLast(R, 1, human)).toMatchObject({ basePriority: 'P2', scope: null });
    expect(s.audit(R, 1).at(-1)).toMatchObject({ reason: 'undo', actor: 'alice' });
    expect(() => s.undoLast(R, 1, human)).not.toThrow(); // undo of the undo restores P0
    const fresh = store();
    seed(fresh, 2);
    expect(() => fresh.undoLast(R, 2, human)).toThrow(/nothing to undo/); // only a migration so far
  });
  it('applies bulk moves atomically and rolls everything back on one invalid item', () => {
    const s = store();
    seed(s, 1, ['P1']); seed(s, 2, ['P1']); seed(s, 3);
    const moved = s.bulkUpdate([{ repository: R, issueNumber: 1 }, { repository: R, issueNumber: 2 }], { lane: 'Backlog' }, human);
    expect(moved.map((m) => m.lane)).toEqual(['Backlog', 'Backlog']);
    expect(() => s.bulkUpdate([{ repository: R, issueNumber: 1 }, { repository: R, issueNumber: 3 }], { lane: 'Ready' }, human)).toThrow(/Ready/);
    expect(s.get(R, 1)!.lane).toBe('Backlog'); // #1 could enter Ready, but the batch rolled back
    expect(s.audit(R, 1)).toHaveLength(2);
  });
  it('expedite has a TTL; snooze keeps an issue out of dispatch until it lapses, both audited and undoable', async () => {
    const s = store();
    seed(s, 1, ['P3', 'factory:ready']);
    s.expedite(R, 1, 2, { ...human, now: '2026-11-03T10:00:00Z' });
    expect(s.get(R, 1)!.expedite).toBe(true);
    expect(s.timers(R, 1).expediteUntil).toBe('2026-11-03T12:00:00.000Z');
    expect(() => s.expedite(R, 1, 0, human)).toThrow(/TTL/);
    s.setTimers(R, 1, { snoozeUntil: '2026-11-04T00:00:00Z' }, human);
    const hook = createBacklogAdmission({ repository: R, store: s, mode: 'enforce', config: { reservedHighPrioritySlots: 0 }, now: () => new Date('2026-11-03T11:00:00Z') });
    const snoozed = await hook({ number: 1, labels: [], timestamp: 'x' });
    expect(snoozed.allow).toBe(false);
    expect(snoozed.reason).toContain('snoozed');
    s.undoLast(R, 1, human);
    expect((await hook({ number: 1, labels: [], timestamp: 'x' })).allow).toBe(true);
    expect(() => s.setTimers(R, 1, { snoozeUntil: 'nonsense' }, human)).toThrow(/timestamp/);
  });
});

describe('readiness checklist', () => {
  const good = '## Acceptance\n- [ ] works\n## Dependencies\nNo dependencies.\nScope: `src/a.ts`\nTests: unit.';
  it('requires acceptance, dependencies and scope for normal work and lists exactly what is missing', () => {
    expect(evaluateReadiness({ body: good, labels: [] })).toMatchObject({ ready: true, missing: [] });
    const thin = evaluateReadiness({ body: 'Please fix the thing', labels: [] });
    expect(thin.ready).toBe(false);
    expect(thin.missing).toEqual(['Acceptance criteria', 'Dependencies / decision gates declared', 'Codebase scope known or marked unknown']);
  });
  it('lets low-risk code-first work skip spec items, but requires approval for high risk', () => {
    expect(evaluateReadiness({ body: '- [ ] fixed', labels: ['type:bug'] })).toMatchObject({ ready: true, codeFirstBypass: true });
    expect(evaluateReadiness({ body: good, labels: ['risk:high'] }).missing).toEqual(['Approval for high-risk change']);
    expect(evaluateReadiness({ body: `${good}\nApproved by: alice`, labels: ['risk:high'] }).ready).toBe(true);
    expect(evaluateReadiness({ body: good, labels: ['risk:high', 'factory:approved'] }).ready).toBe(true);
  });
  it('accepts explicit unknown scope', () => {
    expect(evaluateReadiness({ body: '## Acceptance\nx\nDependencies: none\nScope: unknown', labels: [] }).ready).toBe(true);
  });
});

describe('duplicate candidates', () => {
  const issue = (number: number, title: string, body = '') => ({ repository: R, number, title, body, labels: [] });
  it('flags explicit references and near-identical titles, deterministically, never across repositories', () => {
    const issues = [
      issue(1, 'Crash when saving the inventory'), issue(2, 'Crash saving inventory'), issue(3, 'Totally different thing', 'duplicate of #1'),
      issue(4, 'Unrelated'), { ...issue(5, 'Crash when saving the inventory'), repository: 'other/repo' },
    ];
    const found = findDuplicateCandidates(issues);
    expect(found.map((f) => [f.a, f.b])).toEqual([['o/r#1', 'o/r#3'], ['o/r#1', 'o/r#2']]);
    expect(found[0]).toMatchObject({ score: 1, evidence: ['explicit duplicate reference'] });
    expect(JSON.stringify(findDuplicateCandidates([...issues].reverse()))).toBe(JSON.stringify(found));
  });
  it('treats a shared external link as weak evidence only', () => {
    const found = findDuplicateCandidates([issue(1, 'Alpha one', 'see https://docs.example/x'), issue(2, 'Beta two', 'see https://docs.example/x')]);
    expect(found).toEqual([]);
  });
});
