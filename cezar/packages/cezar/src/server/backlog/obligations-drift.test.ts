import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DRIFT_POLICY, evaluateDrift, type DriftFacts } from './drift.ts';
import { ObligationStore, nextForOutcome, type ObligationError } from './integration-obligations.ts';
import { conflictConfusion, predictionAccuracy, rolloutSummary } from './metrics.ts';
import { obligationKey } from './scheduling.ts';

const stores: ObligationStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
const open = (path = ':memory:') => { const s = new ObligationStore({ path }); stores.push(s); return s; };
const R = 'o/r';
const K12 = obligationKey('o/r#1', 'o/r#2');
const K34 = obligationKey('o/r#3', 'o/r#4');

describe('integration obligations', () => {
  it('is idempotent across replays and duplicate schedulers (shared file)', () => {
    const path = `${process.env.TEMP ?? '/tmp'}/obl-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    const a = open(path), b = open(path);
    const first = a.ensure(R, 'o/r#2', 'o/r#1', K12, { kind: 'forced-overlap', detail: 'alice: deadline' });
    const second = b.ensure(R, 'o/r#1', 'o/r#2', K12, { kind: 'forced-overlap', detail: 'alice: deadline' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.obligation.evidence).toHaveLength(1);
    expect(b.ensure(R, 'o/r#1', 'o/r#2', K12, { kind: 'actual-overlap', detail: 'a.cs' }).obligation.evidence).toHaveLength(2);
    expect(first.obligation.issues).toEqual(['o/r#1', 'o/r#2']);
  });
  it('auto-resolves on clean merge plus passing verification, no GitHub issue created', () => {
    const s = open();
    s.ensure(R, 'o/r#1', 'o/r#2', K12, { kind: 'forced-overlap', detail: 'x' });
    const r = s.applyOutcome(K12, { kind: 'clean-merge', verification: 'passed' });
    expect(r).toMatchObject({ materializeIssue: false, needsIntegrationAgent: false });
    expect(r.obligation.state).toBe('resolved');
    expect(s.head(R)).toBeNull();
  });
  it('semantic conflict or failed verification needs an integration agent and materializes one issue', () => {
    const s = open();
    s.ensure(R, 'o/r#1', 'o/r#2', K12, { kind: 'forced-overlap', detail: 'x' });
    const r = s.applyOutcome(K12, { kind: 'clean-merge', verification: 'failed' });
    expect(r).toMatchObject({ materializeIssue: true, needsIntegrationAgent: true });
    expect(r.obligation.state).toBe('needs-agent');
    s.linkGithubIssue(K12, 300);
    expect(s.linkGithubIssue(K12, 300).githubIssue).toBe(300);
    expect(() => s.linkGithubIssue(K12, 301)).toThrow(/already linked/);
    expect(s.applyOutcome(K12, { kind: 'textual-conflict', paths: ['a'] }).materializeIssue).toBe(false); // already linked
    expect(nextForOutcome({ kind: 'semantic-conflict', detail: 'API mismatch' }).needsIntegrationAgent).toBe(true);
    expect(nextForOutcome({ kind: 'clean-merge', verification: 'not-run' }).state).toBe('verifying');
  });
  it('merges serially per repository and rejects invalid transitions', () => {
    const s = open();
    s.ensure(R, 'o/r#1', 'o/r#2', K12, { kind: 'k', detail: 'd' });
    s.ensure(R, 'o/r#3', 'o/r#4', K34, { kind: 'k', detail: 'd' });
    expect(s.queue(R).map((o) => o.key)).toEqual([K12, K34]);
    try { s.applyOutcome(K34, { kind: 'clean-merge', verification: 'passed' }); throw new Error('expected'); }
    catch (e) { expect((e as ObligationError).code).toBe('not_head'); }
    s.applyOutcome(K12, { kind: 'clean-merge', verification: 'passed' });
    expect(s.head(R)!.key).toBe(K34);
    expect(() => s.transition(K12, 'open', { kind: 'k', detail: 'd' })).toThrow(/not allowed/);
    expect(() => s.transition('nope', 'open', { kind: 'k', detail: 'd' })).toThrow(/no obligation/);
    expect(s.transition(K34, 'cancelled', { kind: 'human', detail: 'dropped' }).state).toBe('cancelled');
  });
});

describe('drift evaluation', () => {
  const base: DriftFacts = { admittedBaseSha: 'a'.repeat(40), currentBaseSha: 'a'.repeat(40), leaseExpired: false, reservation: 'active', unpredictedFiles: [], newOverlap: 'none', replansSoFar: 0, now: '2026-11-03T12:00:00Z' };
  it('does nothing when nothing moved', () => {
    expect(evaluateDrift(base)).toMatchObject({ action: 'none', signals: [] });
  });
  it('replans when the base advanced or many unpredicted files appear', () => {
    expect(evaluateDrift({ ...base, currentBaseSha: 'b'.repeat(40) })).toMatchObject({ action: 'replan', signals: ['base-advanced'] });
    expect(evaluateDrift({ ...base, unpredictedFiles: ['a', 'b', 'c'] }).action).toBe('replan');
    expect(evaluateDrift({ ...base, unpredictedFiles: ['a'] }).action).toBe('recheck-conflicts');
    expect(evaluateDrift({ ...base, newOverlap: 'file' }).action).toBe('replan');
    expect(evaluateDrift({ ...base, newOverlap: 'module' }).action).toBe('none');
  });
  it('rechecks instead of continuing silently on an expired lease or reservation', () => {
    expect(evaluateDrift({ ...base, leaseExpired: true }).action).toBe('recheck-conflicts');
    expect(evaluateDrift({ ...base, reservation: 'none' }).signals).toContain('manifest-expired');
  });
  it('bounds replanning with a budget and a cooldown, then asks a human', () => {
    const drifted = { ...base, currentBaseSha: 'b'.repeat(40) };
    expect(evaluateDrift({ ...drifted, replansSoFar: DEFAULT_DRIFT_POLICY.maxReplans })).toMatchObject({ action: 'pause-for-human' });
    const cooling = evaluateDrift({ ...drifted, replansSoFar: 1, lastReplanAt: '2026-11-03T11:55:00Z' });
    expect(cooling.action).toBe('pause-for-human');
    expect(cooling.reasons.join()).toContain('cooldown');
    expect(evaluateDrift({ ...drifted, replansSoFar: 1, lastReplanAt: '2026-11-03T11:00:00Z' }).action).toBe('replan');
  });
});

describe('pilot metrics', () => {
  it('computes prediction precision/recall case-insensitively and handles empty input', () => {
    expect(predictionAccuracy([])).toMatchObject({ samples: 0, precision: null, recall: null });
    const acc = predictionAccuracy([{ issue: '1', predicted: ['A.cs', 'b.cs'], actual: ['a.cs', 'c.cs'] }]);
    expect(acc).toMatchObject({ precision: 0.5, recall: 0.5, falseNegatives: 1, falsePositives: 1 });
  });
  it('keeps unknown separate from a safe "none" in the conflict confusion matrix', () => {
    const m = conflictConfusion([
      { predicted: 'file', actualConflict: true }, { predicted: 'file', actualConflict: false },
      { predicted: 'none', actualConflict: true }, { predicted: 'none', actualConflict: false }, { predicted: 'unknown', actualConflict: true },
    ]);
    expect(m).toEqual({ truePositive: 1, falsePositive: 1, falseNegative: 1, trueNegative: 1, unknown: 1, recall: 0.5, precision: 0.5 });
  });
  it('flags throughput and merge-debt regressions against a baseline', () => {
    const baseline = { openObligations: 1, admitted: 10, deferredForConflict: 2, completed: 10, windowHours: 10 };
    const worse = { openObligations: 5, admitted: 8, deferredForConflict: 4, completed: 8, windowHours: 10 };
    expect(rolloutSummary(worse, baseline).regression).toEqual({ throughput: true, mergeDebt: true });
    expect(rolloutSummary(baseline, baseline).regression).toEqual({ throughput: false, mergeDebt: false });
    expect(rolloutSummary({ ...baseline, completed: 0 }).mergeDebtPerCompleted).toBeNull();
  });
});
