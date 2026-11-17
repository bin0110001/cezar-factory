import { describe, expect, it } from 'vitest';
import {
  METRIC_CLASS, MetricStore, coverageDelta, debtSignals, metricSampleSchema, parseComplexity, parseCoverage, parseDeadCode, parseDuplication, parseWarnings,
  type ParseContext,
} from './quality-metrics.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ctx = (sha = A, tool = 'tool'): ParseContext => ({ sha, tool, toolVersion: '1.0.0', root: '/repo' });

describe('metric parsers', () => {
  it('complexity per function, scoped and relative to the repository root', () => {
    const s = parseComplexity(JSON.stringify([{ path: '/repo/src/a.ts', function: 'run', complexity: 14 }, { path: 'src/b.ts', function: 'go', complexity: 3 }]), ctx());
    expect(s.map((m) => [m.scope, m.value, m.unit])).toEqual([['src/a.ts#run', 14, 'score'], ['src/b.ts#go', 3, 'score']]);
    expect(() => parseComplexity('{}', ctx())).toThrow();
  });

  it('duplication, dead code, warnings and coverage', () => {
    expect(parseDuplication(JSON.stringify({ statistics: { total: { percentage: 6.5 } } }), ctx())[0]).toMatchObject({ name: 'duplication', scope: 'repo', value: 6.5, unit: 'percent' });
    const dead = parseDeadCode(JSON.stringify({ items: [{ path: '/repo/a.ts' }, { path: '/repo/a.ts' }, { path: 'b.ts' }] }), ctx());
    expect(dead.map((m) => [m.scope, m.value])).toEqual([['repo', 3], ['a.ts', 2], ['b.ts', 1]]);
    expect(parseWarnings(JSON.stringify([{ severity: 'warning' }, { severity: 'Warning' }, { severity: 'error' }]), ctx())[0]?.value).toBe(2);
    expect(parseCoverage(JSON.stringify({ lines: { pct: 81.2 } }), ctx())[0]).toMatchObject({ name: 'coverage', value: 81.2 });
    expect(() => parseDuplication('{}', ctx())).toThrow();
    expect(() => parseCoverage('{"lines":{}}', ctx())).toThrow();
  });

  it('samples validate: a branch name is not a SHA and values must be finite', () => {
    expect(metricSampleSchema.safeParse({ sha: 'main', name: 'warnings', scope: 'repo', value: 1, unit: 'count', tool: 't', toolVersion: '1' }).success).toBe(false);
    expect(metricSampleSchema.safeParse({ sha: A, name: 'warnings', scope: 'repo', value: Number.NaN, unit: 'count', tool: 't', toolVersion: '1' }).success).toBe(false);
  });
});

describe('per-SHA store and coverage change', () => {
  it('records metrics per SHA, immutably', () => {
    const store = new MetricStore();
    store.record(parseCoverage(JSON.stringify({ lines: { pct: 80 } }), ctx(A)));
    store.record(parseCoverage(JSON.stringify({ lines: { pct: 80 } }), ctx(A))); // replay of the same value is fine
    expect(store.forSha(A)).toHaveLength(1);
    expect(store.forSha(B)).toEqual([]);
    expect(() => store.record(parseCoverage(JSON.stringify({ lines: { pct: 70 } }), ctx(A)))).toThrow(/already recorded/);
  });

  it('coverage delta against a baseline SHA flags a regression beyond tolerance', () => {
    const store = new MetricStore();
    store.record(parseCoverage(JSON.stringify({ lines: { pct: 80 } }), ctx(A)));
    store.record(parseCoverage(JSON.stringify({ lines: { pct: 78.5 } }), ctx(B)));
    expect(coverageDelta(store, A, B)).toEqual({ baseline: 80, current: 78.5, delta: -1.5, regressed: true });
    expect(coverageDelta(store, A, B, 2)?.regressed).toBe(false);
    expect(coverageDelta(store, A, 'c'.repeat(40))).toBeUndefined(); // no coverage recorded: no verdict
  });
});

describe('metrics are never security severity', () => {
  it('threshold breaches are quality-debt signals capped below high', () => {
    const samples = [
      ...parseComplexity(JSON.stringify([{ path: 'a.ts', function: 'big', complexity: 40 }, { path: 'a.ts', function: 'mid', complexity: 12 }, { path: 'a.ts', function: 'ok', complexity: 2 }]), ctx()),
      ...parseDuplication(JSON.stringify({ statistics: { total: { percentage: 9 } } }), ctx()),
      ...parseWarnings(JSON.stringify([{ severity: 'warning' }]), ctx()),
    ];
    const signals = debtSignals(samples, { complexityMedium: 30, complexityLow: 10, duplicationPercent: 5, warningCount: 1 });
    expect(signals.map((s) => [s.metric, s.scope, s.severity])).toEqual([['complexity', 'a.ts#big', 'medium'], ['complexity', 'a.ts#mid', 'low'], ['duplication', 'repo', 'low'], ['warnings', 'repo', 'low']]);
    expect(signals.every((s) => s.class === METRIC_CLASS && (s.severity === 'low' || s.severity === 'medium'))).toBe(true);
    expect(debtSignals(samples, {})).toEqual([]);
  });
});
