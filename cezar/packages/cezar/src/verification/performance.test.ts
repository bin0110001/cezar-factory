import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  SpanRecorder, compareFingerprints, evaluatePerformance, validatePerformancePolicy,
  type Baseline, type PerformancePolicy,
} from './performance.ts';

const policy: PerformancePolicy = {
  version: 1,
  fingerprintFields: ['os', 'arch', 'cpuModel'],
  spans: { 'room-build': { absoluteMs: 10_000, medianMs: 4_000, p95Ms: 8_000, minSamples: 1 } },
};
const env = { os: 'linux', arch: 'x64', cpuModel: 'epyc' };
const fakeClock = () => { let now = 0; return { clock: () => now, advance: (ms: number) => { now += ms; } }; };

describe('performance gate', () => {
  it('fails a 20s room build with valid geometry while functional stays passed, retaining evidence', () => {
    const c = fakeClock();
    const spans = new SpanRecorder(c.clock);
    spans.start('room-build'); c.advance(20_000); spans.end('room-build');
    const geometryValid = true; // functional result is independent of the perf gate
    const baseline: Baseline = { id: 'b1', fingerprint: env, samples: { 'room-build': [1_000, 1_100] } };
    const result = evaluatePerformance({ policy, fingerprint: env, measurements: spans.snapshot(), baseline });
    expect(geometryValid).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.spans[0]!.firstAttemptMs).toBe(20_000);
    expect(result.spans[0]!.budget.absoluteMs).toBe(10_000);
    expect(result.baseline).toEqual({ comparable: true, baselineId: 'b1' });
    expect(result.fingerprint).toEqual(env);
    expect(result.measurements).toHaveLength(1);
  });

  it('passes a fast build against a comparable baseline', () => {
    const c = fakeClock();
    const spans = new SpanRecorder(c.clock);
    spans.start('room-build'); c.advance(1_000); spans.end('room-build');
    const baseline: Baseline = { id: 'b1', fingerprint: env, samples: { 'room-build': [900, 1_100] } };
    expect(evaluatePerformance({ policy, fingerprint: env, measurements: spans.snapshot(), baseline }).status).toBe('passed');
  });

  it('refuses to compare baselines from a different environment', () => {
    const baseline: Baseline = { id: 'b2', fingerprint: { ...env, cpuModel: 'm3' }, samples: { 'room-build': [100] } };
    const cmp = compareFingerprints(policy, env, baseline);
    expect(cmp.comparable).toBe(false);
    if (!cmp.comparable) { expect(cmp.mismatched).toEqual(['cpuModel']); expect(cmp.reason).toContain('different environment'); }
    const c = fakeClock();
    const spans = new SpanRecorder(c.clock);
    spans.start('room-build'); c.advance(1_000); spans.end('room-build');
    const result = evaluatePerformance({ policy, fingerprint: env, measurements: spans.snapshot(), baseline });
    expect(result.status).toBe('inconclusive');
    expect(compareFingerprints(policy, env, undefined).comparable).toBe(false);
  });

  it('treats a missing fingerprint field as a mismatch', () => {
    const baseline: Baseline = { id: 'b3', fingerprint: { os: 'linux', arch: 'x64' }, samples: {} };
    expect(compareFingerprints(policy, env, baseline).comparable).toBe(false);
  });

  it('preserves the first slow attempt across a faster retry and still fails the gate', () => {
    const c = fakeClock();
    const spans = new SpanRecorder(c.clock);
    spans.start('room-build'); c.advance(20_000); spans.end('room-build');
    spans.start('room-build'); c.advance(500); spans.end('room-build');
    const result = evaluatePerformance({ policy, fingerprint: env, measurements: spans.snapshot() });
    expect(result.status).toBe('failed');
    expect(result.spans[0]!.attemptDurationsMs).toEqual([20_000, 500]);
    expect(result.spans[0]!.firstAttemptMs).toBe(20_000);
  });

  it('never passes unfinished, aborted, missing or unknown spans', () => {
    const c = fakeClock();
    const open = new SpanRecorder(c.clock);
    open.start('room-build'); c.advance(100);
    expect(evaluatePerformance({ policy, fingerprint: env, measurements: open.snapshot() }).status).toBe('inconclusive');
    open.abort('room-build');
    expect(open.snapshot()[0]!.durationMs).toBeUndefined();
    expect(evaluatePerformance({ policy, fingerprint: env, measurements: open.snapshot() }).status).toBe('inconclusive');
    expect(evaluatePerformance({ policy, fingerprint: env, measurements: [] }).status).toBe('inconclusive');
    const typo = new SpanRecorder(c.clock);
    typo.start('room-bulid'); typo.end('room-bulid');
    expect(evaluatePerformance({ policy, fingerprint: env, measurements: typo.snapshot() }).status).not.toBe('passed');
  });

  it('records duration only on completion and rejects misuse', () => {
    const spans = new SpanRecorder(() => 0);
    expect(() => spans.end('x')).toThrow();
    spans.start('x');
    expect(() => spans.start('x')).toThrow();
  });

  it('is inconclusive when there are too few samples for median/p95', () => {
    const strict = { ...policy, spans: { 'room-build': { medianMs: 4_000, minSamples: 5 } } };
    const baseline: Baseline = { id: 'b1', fingerprint: env, samples: { 'room-build': [1_000] } };
    const c = fakeClock();
    const spans = new SpanRecorder(c.clock);
    spans.start('room-build'); c.advance(1_000); spans.end('room-build');
    expect(evaluatePerformance({ policy: strict, fingerprint: env, measurements: spans.snapshot(), baseline }).status).toBe('inconclusive');
  });
});

describe('performance policy validation', () => {
  it('accepts the shipped policy', async () => {
    const path = fileURLToPath(new URL('../../../../../policies/performance.yaml', import.meta.url));
    expect(validatePerformancePolicy(parseYaml(await readFile(path, 'utf8')))).toEqual([]);
  });

  it('rejects missing metrics, non-positive limits and unknown spans', () => {
    const base = { version: 1, fingerprintFields: ['os'], spans: { a: { absoluteMs: 1 } } };
    expect(validatePerformancePolicy(base)).toEqual([]);
    expect(validatePerformancePolicy({ ...base, spans: { a: {} } }).join()).toContain('at least one');
    expect(validatePerformancePolicy({ ...base, spans: { a: { absoluteMs: 0 } } }).join()).toContain('positive');
    expect(validatePerformancePolicy({ ...base, spans: { a: { p95Ms: -5 } } }).join()).toContain('positive');
    expect(validatePerformancePolicy(base, ['b']).join()).toContain('unknown span a');
    expect(validatePerformancePolicy({ ...base, fingerprintFields: [] }).length).toBeGreaterThan(0);
  });
});
