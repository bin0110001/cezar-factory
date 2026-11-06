import { describe, expect, it } from 'vitest';
import { DEFAULT_FIELDS, type BacklogRecord } from './model.ts';
import { rankCandidates } from './ranking.ts';
import { DEFAULT_SCHEDULING_CONFIG, decideOne } from './scheduling.ts';
import { buildBacklogView } from './view.ts';
import type { Obligation } from './integration-obligations.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const rec = (n: number, patch: Partial<BacklogRecord>): BacklogRecord => ({ ...DEFAULT_FIELDS, repository: 'o/r', issueNumber: n, policyConstraints: [], issueState: 'open', archived: false, provenance: {}, revision: 1, updatedAt: 'x', ...patch });

describe('backlog view', () => {
  it('groups cards by lane with scheduler reasons, badges, conflict edges, merge debt and the override audit', () => {
    const ranked = rankCandidates([
      { record: rec(1, { basePriority: 'P0', lane: 'Refinement' }), createdAt: '2026-11-01T00:00:00Z' },
      { record: rec(2, { basePriority: 'P2', lane: 'Ready', hold: false }), createdAt: '2026-11-01T00:00:00Z' },
      { record: rec(3, { lane: 'Inbox' }), createdAt: '2026-11-01T00:00:00Z' },
    ], NOW);
    const ready = ranked.find((r) => r.record.issueNumber === 2)!;
    const decision = decideOne({ candidate: ready, dependency: { status: 'blocked', blockers: ['#9'], graphRevision: 4 }, capacity: { status: 'available' } }, [], DEFAULT_SCHEDULING_CONFIG);
    const obligation: Obligation = { key: 'integration:o/r#4+o/r#5', issues: ['o/r#4', 'o/r#5'], state: 'needs-agent', evidence: [], githubIssue: 77, seq: 1, repository: 'o/r', createdAt: 'x', updatedAt: 'x' };
    const view = buildBacklogView({
      ranked, decisions: [decision], obligations: [obligation, { ...obligation, key: 'k2', state: 'resolved' }],
      audits: [{ id: 'o/r#2', entries: [{ cursor: 1, key: 'o/r#2', revision: 2, actor: 'alice', source: 'human', reason: 'urgent', before: {}, after: { basePriority: 'P2' }, createdAt: '2026-11-03T10:00:00Z' }] }],
    });
    expect(view.lanes.map((l) => l.lane)).toEqual(['Inbox', 'Backlog', 'Refinement', 'Ready', 'Active', 'Review', 'Done']);
    const byId = Object.fromEntries(view.lanes.flatMap((l) => l.cards).map((c) => [c.id, c]));
    expect(byId['o/r#1']!.status).toMatchObject({ kind: 'not-dispatchable', reasonCode: 'gated' });
    expect(byId['o/r#1']!.status.detail).toContain('Refinement');
    expect(byId['o/r#2']!.status).toMatchObject({ reasonCode: 'blocked-dependency' });
    expect(byId['o/r#3']!.badges).toEqual(expect.arrayContaining(['unranked', 'priority-unset']));
    expect(view.views.blocked).toEqual(['o/r#2']);
    expect(view.mergeDebt).toMatchObject({ open: 1, needsAgent: 1, items: [{ githubIssue: 77 }] });
    expect(view.edges).toEqual([{ from: 'o/r#4', to: 'o/r#5', level: 'file', source: 'obligation' }]);
    expect(view.overrideAudit).toEqual([{ id: 'o/r#2', at: '2026-11-03T10:00:00Z', actor: 'alice', reason: 'urgent', changed: ['basePriority'] }]);
    expect(buildBacklogView({ ranked: [] }).generatedFrom.scoreConfigVersion).toBeNull();
  });
});
