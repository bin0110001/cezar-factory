import { describe, expect, it } from 'vitest';
import { parseShardManifest } from './shard-manifest.ts';
import { planShards, planRetry, reassignPartition, type PlanInputs, type ShardWorker } from './shard-planner.ts';
import { aggregateShardResults, type PartitionResult } from './shard-aggregate.ts';
import { parseWorkerCapabilities } from './worker-capabilities.ts';

const worker = (id: string, extra: object = {}): ShardWorker => ({
  id, envKey: 'linux', capabilities: parseWorkerCapabilities({ os: 'linux', ...extra }),
});
const safe = { parallelSafe: true, shardable: true };

function inputs(over: Partial<PlanInputs> = {}): PlanInputs {
  const manifest = parseShardManifest({
    revision: 'm1', discovery: 'supported', fullSuiteCommand: 'make test',
    tests: [
      { id: 'big', ...safe, idempotent: true },
      { id: 'a', ...safe, idempotent: true }, { id: 'b', ...safe, idempotent: true },
      { id: 'c', ...safe, idempotent: true }, { id: 'd', ...safe, idempotent: true },
    ],
  });
  return {
    manifest, selected: ['big', 'a', 'b', 'c', 'd'], workers: [worker('w1'), worker('w2')],
    history: { linux: { big: 4000, a: 1000, b: 1000, c: 1000, d: 1000 } },
    commit: 'abc', policyRevision: 'p1', optIn: true, ...over,
  };
}

const result = (plan: ReturnType<typeof planShards>, pid: string, over: Partial<PartitionResult> = {}): PartitionResult => {
  const p = plan.partitions.find((x) => x.id === pid)!;
  return {
    partitionId: pid, attempt: 1, planId: plan.planId, commit: plan.commit, manifestRevision: plan.manifestRevision,
    workerId: p.workerId, envKey: p.envKey, outcome: 'completed',
    tests: p.testIds.map((id) => ({ id, status: 'pass' as const, durationMs: 1000, artifactHashes: ['h'] })),
    wallMs: 5000, queueMs: 50, transferMs: 50, ...over,
  };
};

describe('planShards', () => {
  it('balances predicted work, not test count, and is reproducible', () => {
    const plan = planShards(inputs());
    const sizes = plan.partitions.map((p) => p.testIds.length).sort();
    expect(sizes).toEqual([1, 4]); // 4000ms alone vs four 1000ms tests
    expect(plan.partitions.map((p) => p.predictedMs)).toEqual([4000, 4000]);
    expect(planShards(inputs())).toEqual(plan);
    expect(planShards(inputs({ workers: [worker('w2'), worker('w1')] })).planId).toBe(plan.planId);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.predictedSerialMs).toBe(8000);
  });

  it('falls back deterministically without history and records the reason', () => {
    const plan = planShards(inputs({ history: undefined, defaultDurationMs: 10 }));
    expect(plan.testReasons.a).toContain('fallback-default');
    expect(plan.predictedSerialMs).toBe(50);
  });

  it('does not add partitions when overhead outweighs the gain', () => {
    const plan = planShards(inputs({ partitionOverheadMs: 100000 }));
    expect(plan.partitions).toHaveLength(1);
    expect(plan.reasons).toContain('overhead-cap');
  });

  it('keeps non-shardable, shared-state and same-group tests serialized together', () => {
    const manifest = parseShardManifest({
      revision: 'm', discovery: 'supported',
      tests: [
        { id: 's1' }, { id: 's2' },
        { id: 'g1', parallelSafe: true, shardable: true, isolationGroup: 'db' },
        { id: 'g2', parallelSafe: true, shardable: true, isolationGroup: 'db' },
        { id: 'f1', ...safe }, { id: 'f2', ...safe },
      ],
    });
    const plan = planShards(inputs({ manifest, selected: manifest.tests.map((t) => t.id), history: undefined }));
    const where = (id: string) => plan.partitions.find((p) => p.testIds.includes(id))!.id;
    expect(where('s1')).toBe(where('s2'));
    expect(where('g1')).toBe(where('g2'));
    expect(where('f1')).not.toBe(where('f2'));
  });

  it('adds mandatory tests the selection omitted and lists unplaceable ones as unplaced', () => {
    const manifest = parseShardManifest({
      revision: 'm', discovery: 'supported',
      tests: [{ id: 'x', ...safe }, { id: 'gpu', ...safe, requires: { gpu: true } }],
    });
    const plan = planShards(inputs({ manifest, selected: ['x'] }));
    expect(plan.expectedTestIds).toEqual(['gpu', 'x']);
    expect(plan.testReasons.gpu).toContain('mandatory-added');
    expect(plan.unplaceable).toEqual([{ testId: 'gpu', reason: 'no-compatible-worker' }]);
  });

  it('uses the project-owned full suite unless opted in with supported discovery', () => {
    expect(planShards(inputs({ optIn: false })).mode).toBe('full-suite');
    const unsupported = parseShardManifest({ revision: 'm', fullSuiteCommand: 'make test' });
    const plan = planShards(inputs({ manifest: unsupported, selected: [] }));
    expect(plan).toMatchObject({ mode: 'full-suite', fullSuiteCommand: 'make test', reasons: ['discovery-unsupported'] });
  });

  it('rejects selected tests missing from the manifest and duplicate ids', () => {
    expect(() => planShards(inputs({ selected: ['nope'] }))).toThrow(/not in the manifest/);
    expect(() => parseShardManifest({ revision: 'm', tests: [{ id: 'a' }, { id: 'a' }] })).toThrow(/duplicate/);
  });

  it('keeps a render-requiring test off workers without a display (no headless downgrade)', () => {
    const manifest = parseShardManifest({
      revision: 'm', discovery: 'supported',
      tests: [{ id: 'shot', ...safe, requires: { godotGui: true, display: ':0' } }],
    });
    const plan = planShards(inputs({ manifest, selected: ['shot'], workers: [worker('w1')] }));
    expect(plan.unplaceable[0].testId).toBe('shot');
    const gui = worker('g', { godot: { headless: true, gui: true }, displays: [':0'] });
    expect(planShards(inputs({ manifest, selected: ['shot'], workers: [worker('w1'), gui] })).partitions[0].workerId).toBe('g');
  });
});

describe('aggregateShardResults', () => {
  const plan = planShards(inputs());

  it('consolidates two workers into one verified run with speedup and overhead', () => {
    const r = aggregateShardResults({ plan, results: [result(plan, 'p1'), result(plan, 'p2', { wallMs: 4000 })] });
    expect(r.verdict).toBe('pass');
    expect(r.verified).toBe(true);
    expect(r.ledger).toHaveLength(5);
    expect(r.timing).toMatchObject({ serialMs: 5000, wallMs: 5000, overheadMs: 200 });
    expect(r.lineage).toHaveLength(2);
  });

  it('never passes with a missing, canceled or crashed partition', () => {
    const missing = aggregateShardResults({ plan, results: [result(plan, 'p1')] });
    expect(missing.verdict).toBe('incomplete');
    expect(missing.counts.untested).toBeGreaterThan(0);
    const canceled = aggregateShardResults({ plan, results: [result(plan, 'p1'), result(plan, 'p2', { outcome: 'canceled', tests: [] })] });
    expect(canceled.verdict).toBe('incomplete');
    expect(canceled.counts.canceled).toBeGreaterThan(0);
    const crashed = aggregateShardResults({ plan, results: [result(plan, 'p1'), result(plan, 'p2', { outcome: 'crashed', tests: [] })] });
    expect(crashed.verdict).toBe('infra');
    // Passing tests reported by a crashed partition are not trusted.
    const lying = aggregateShardResults({ plan, results: [result(plan, 'p1'), result(plan, 'p2', { outcome: 'crashed' })] });
    expect(lying.verified).toBe(false);
  });

  it('rejects stale attempts, stale plans, late results; dedupes identical, flags conflicts', () => {
    const base = [result(plan, 'p1'), result(plan, 'p2')];
    const stale = aggregateShardResults({ plan, results: [...base, result(plan, 'p2', { attempt: 2 })], currentAttempts: { p2: 1 } });
    expect(stale.rejected).toEqual([{ partitionId: 'p2', attempt: 2, reason: 'stale-attempt' }]);
    expect(stale.verdict).toBe('pass');
    expect(aggregateShardResults({ plan, results: [...base, { ...result(plan, 'p2'), planId: 'old' }] }).rejected[0].reason).toBe('stale-plan');
    const late = aggregateShardResults({ plan, results: [result(plan, 'p1'), result(plan, 'p2', { receivedAtMs: 20 })], deadlineMs: 10 });
    expect(late.rejected[0].reason).toBe('late');
    expect(late.verdict).toBe('incomplete');
    expect(aggregateShardResults({ plan, results: [...base, result(plan, 'p2')] }).verdict).toBe('pass');
    const p2 = result(plan, 'p2');
    const conflict = aggregateShardResults({ plan, results: [result(plan, 'p1'), p2, { ...p2, tests: p2.tests.map((t) => ({ ...t, status: 'fail' as const })) }] });
    expect(conflict.verdict).toBe('incomplete');
    expect(conflict.rejected[0].reason).toBe('duplicate-conflict');
  });

  it('a failure fails the run; unexpected tests are reported and not counted; skipped mandatory is not pass', () => {
    const p1 = result(plan, 'p1');
    const failed = aggregateShardResults({ plan, results: [{ ...p1, tests: [{ id: p1.tests[0].id, status: 'fail' }, ...p1.tests.slice(1)] }, result(plan, 'p2')] });
    expect(failed.verdict).toBe('fail');
    const extra = aggregateShardResults({ plan, results: [{ ...p1, tests: [...p1.tests, { id: 'ghost', status: 'pass' }] }, result(plan, 'p2')] });
    expect(extra.unexpected).toEqual([{ partitionId: 'p1', testId: 'ghost' }]);
    const skipped = aggregateShardResults({ plan, results: [{ ...p1, tests: p1.tests.map((t) => ({ ...t, status: 'skipped' as const })) }, result(plan, 'p2')] });
    expect(skipped.verdict).toBe('incomplete');
  });

  it('unplaceable required tests keep the run unverified', () => {
    const manifest = parseShardManifest({ revision: 'm', discovery: 'supported', tests: [{ id: 'x', ...safe }, { id: 'gpu', ...safe, requires: { gpu: true } }] });
    const pl = planShards(inputs({ manifest, selected: ['x', 'gpu'] }));
    const r = aggregateShardResults({ plan: pl, results: [result(pl, 'p1')] });
    expect(r.verdict).toBe('incomplete');
    expect(r.ledger.find((e) => e.testId === 'gpu')).toMatchObject({ status: 'untested', note: 'no-compatible-worker' });
  });

  it('full-suite fallback verifies only on a fresh zero exit', () => {
    const fb = planShards(inputs({ optIn: false }));
    const run = (over: Partial<PartitionResult>) => aggregateShardResults({
      plan: fb, results: [{ ...result(fb, 'full-suite'), tests: [], ...over }],
    }).verdict;
    expect(run({ fullSuiteExitCode: 0 })).toBe('pass');
    expect(run({ fullSuiteExitCode: 1 })).toBe('fail');
    expect(run({})).toBe('incomplete');
    expect(run({ fullSuiteExitCode: 0, outcome: 'crashed' })).toBe('infra');
    expect(aggregateShardResults({ plan: fb, results: [] }).verdict).toBe('incomplete');
  });
});

describe('reassignment and retry', () => {
  const plan = planShards(inputs());
  const all = [worker('w1'), worker('w2'), worker('w3')];
  const req = () => ({});
  it('moves only never-started partitions', () => {
    expect(reassignPartition(plan, 'p1', { state: 'pending', attempt: 1 }, all, req)).toEqual({ ok: true, workerId: expect.stringMatching(/w[23]/) });
    expect(reassignPartition(plan, 'p1', { state: 'started', attempt: 1 }, all, req)).toEqual({ ok: false, reason: 'started' });
    expect(reassignPartition(plan, 'zz', { state: 'pending', attempt: 1 }, all, req)).toEqual({ ok: false, reason: 'unknown-partition' });
  });
  it('retries idempotent partitions with a bounded, new attempt only', () => {
    expect(planRetry(plan, 'p1', { state: 'finished', attempt: 1 })).toEqual({ ok: true, attempt: 2 });
    expect(planRetry(plan, 'p1', { state: 'finished', attempt: 2 })).toEqual({ ok: false, reason: 'attempts-exhausted' });
    expect(planRetry(plan, 'p1', { state: 'started', attempt: 1 })).toEqual({ ok: false, reason: 'still-running' });
    const manifest = parseShardManifest({ revision: 'm', discovery: 'supported', tests: [{ id: 'x', ...safe }] });
    const unsafe = planShards(inputs({ manifest, selected: ['x'] }));
    expect(planRetry(unsafe, 'p1', { state: 'finished', attempt: 1 })).toEqual({ ok: false, reason: 'not-idempotent' });
  });
});
