import { describe, expect, it } from 'vitest';
import { dependencyNodeId, type DependencyGraphEdge, type DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { diagnoseStalls } from './stalls.ts';

const at = '2026-10-30T12:00:00.000Z';
const repository = 'acme/work';
const nid = (n: number) => dependencyNodeId('issue', repository, n);
let seq = 0;
const edge = (from: string, to: string): DependencyGraphEdge => ({
  id: `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`, kind: 'BLOCKS', from, to, direction: 'from-to',
  provenance: { origin: 'github-native', authority: 'verified', confidence: 1, recordedAt: at, evidence: [] }, createdAt: at, updatedAt: at,
});
const issue = (number: number, labels: string[] = ['factory:ready'], state: 'open' | 'closed' = 'open') => ({
  kind: 'issue' as const, id: nid(number), repository, number, title: `Issue ${number}`, state, labels,
  url: `https://github.com/acme/work/issues/${number}`, revision: at, updatedAt: at,
});
function snap(nodes: ReturnType<typeof issue>[], edges: DependencyGraphEdge[] = [], status: 'fresh' | 'stale' = 'fresh'): DependencyGraphSnapshot {
  return { schemaVersion: 1, repository, revision: 7, createdAt: at, source: { status, lastSuccessfulSyncAt: new Date().toISOString() }, nodes, edges, decisions: [] };
}
const CONSUMED = new Set(['factory:new', 'factory:needs-plan', 'factory:ready', 'factory:review']);
const byNumber = (report: ReturnType<typeof diagnoseStalls>, n: number) => report.items.find((item) => item.number === n)!;

describe('diagnoseStalls', () => {
  it('reports idle with no open work and healthy when something can run', () => {
    expect(diagnoseStalls({ snapshot: snap([issue(1, ['factory:done'], 'closed')]) }).verdict).toBe('idle');
    const report = diagnoseStalls({ snapshot: snap([issue(1), issue(2)], [edge(nid(1), nid(2))]), consumedLabels: CONSUMED });
    expect(report.verdict).toBe('healthy');
    expect(byNumber(report, 1).class).toBe('runnable');
    expect(byNumber(report, 2)).toMatchObject({ class: 'blocked', reason: 'blocked-by-work', blockerIds: [nid(1)] });
  });

  it('marks a dependency cycle and everything beneath it stuck, and the whole system stalled when nothing else can run', () => {
    const report = diagnoseStalls({ snapshot: snap([issue(1), issue(2), issue(3)], [edge(nid(1), nid(2)), edge(nid(2), nid(1)), edge(nid(2), nid(3))]), consumedLabels: CONSUMED });
    expect(report.verdict).toBe('stalled');
    expect(report.cycles).toEqual([[nid(1), nid(2)]]);
    expect(byNumber(report, 1)).toMatchObject({ class: 'stuck', reason: 'dependency-cycle' });
    expect(byNumber(report, 3)).toMatchObject({ class: 'stuck', reason: 'blocked-by-stuck', rootCauseIds: [nid(1), nid(2)] });
  });

  it('stays healthy but flags stuck work when an unrelated issue can still run', () => {
    const report = diagnoseStalls({ snapshot: snap([issue(1), issue(2), issue(3)], [edge(nid(1), nid(2)), edge(nid(2), nid(1))]), consumedLabels: CONSUMED });
    expect(report.verdict).toBe('healthy');
    expect(report.summary).toMatch(/2 are stuck/);
    expect(byNumber(report, 3).class).toBe('runnable');
  });

  it('treats waiting on a person as an acceptable stop, not a stall', () => {
    const report = diagnoseStalls({ snapshot: snap([issue(1, ['factory:needs-help']), issue(2, ['factory:human-review']), issue(3)], [edge(nid(1), nid(3))]), consumedLabels: CONSUMED });
    expect(report.verdict).toBe('waiting');
    expect(report.counts.stuck).toBe(0);
    expect(byNumber(report, 3)).toMatchObject({ class: 'waiting', reason: 'waiting-on-human' });
  });

  it('flags a factory:blocked label with no open blocker', () => {
    const report = diagnoseStalls({ snapshot: snap([issue(1, ['factory:blocked']), issue(2, ['factory:ready']), issue(3, ['factory:blocked'])], [edge(nid(2), nid(3))]), consumedLabels: CONSUMED });
    expect(byNumber(report, 1)).toMatchObject({ class: 'stuck', reason: 'stale-blocked-label' });
    // #3 is blocked by open #2, so its label is explained.
    expect(byNumber(report, 3).reason).not.toBe('stale-blocked-label');
  });

  it('detects lanes no enabled automation consumes, and unlabeled issues', () => {
    const report = diagnoseStalls({ snapshot: snap([issue(1, ['factory:investigate']), issue(2, []), issue(3, ['factory:ready'])]), consumedLabels: CONSUMED });
    expect(byNumber(report, 1)).toMatchObject({ class: 'stuck', reason: 'no-consumer' });
    expect(byNumber(report, 2)).toMatchObject({ class: 'stuck', reason: 'no-state-label' });
    expect(report.verdict).toBe('healthy');
    const none = diagnoseStalls({ snapshot: snap([issue(1, ['factory:investigate']), issue(2, ['factory:needs-plan'])]), consumedLabels: new Set(['factory:ready']) });
    expect(none.verdict).toBe('stalled');
    // Without consumer data the label checks are skipped rather than guessed.
    expect(diagnoseStalls({ snapshot: snap([issue(1, ['factory:investigate'])]) }).verdict).toBe('healthy');
  });

  it('ignores tracking epics and closed blockers', () => {
    const report = diagnoseStalls({ snapshot: snap([issue(1, ['factory:tracking']), issue(2), issue(3, ['factory:done'], 'closed')], [edge(nid(3), nid(2)), edge(nid(2), nid(1))]), consumedLabels: CONSUMED });
    expect(report.items.map((item) => item.number)).toEqual([2]);
    expect(byNumber(report, 2).class).toBe('runnable');
  });

  it('does not claim a stall from stale data, but still reports cycles', () => {
    expect(diagnoseStalls({ snapshot: snap([issue(1)], [], 'stale'), consumedLabels: CONSUMED }).verdict).toBe('unknown');
    expect(diagnoseStalls({ snapshot: snap([issue(1), issue(2)], [edge(nid(1), nid(2)), edge(nid(2), nid(1))], 'stale'), consumedLabels: CONSUMED }).verdict).toBe('stalled');
  });

  it('classifies a deep chain without recursion', () => {
    const count = 4_000;
    const nodes = Array.from({ length: count }, (_, i) => issue(i + 1));
    const edges = Array.from({ length: count - 1 }, (_, i) => edge(nid(i + 1), nid(i + 2)));
    const started = Date.now();
    const report = diagnoseStalls({ snapshot: snap(nodes, edges), consumedLabels: CONSUMED });
    expect(report.counts).toMatchObject({ runnable: 1, blocked: count - 1, stuck: 0 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
