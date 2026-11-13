import { createHash } from 'node:crypto';
import type { ShardManifest, ShardTest } from './shard-manifest.ts';
import { matchRequirements, type JobRequirements, type WorkerCapabilities } from './worker-capabilities.ts';

/**
 * Deterministic shard planner (#216). Pure: same inputs give a byte-identical plan.
 * No LLM, no clock, no host knowledge. Workers are described by their capabilities and an
 * opaque environment key (history is only comparable within one environment key).
 */
export const SHARD_PLAN_VERSION = 1;

export type ReasonCode =
  | 'history' | 'override' | 'fallback-default'
  | 'isolation-group' | 'shared-setup' | 'not-parallel-safe' | 'not-shardable' | 'free'
  | 'mandatory-added' | 'no-compatible-worker' | 'conflicting-requirements'
  | 'sharding-disabled' | 'discovery-unsupported' | 'overhead-cap';

export interface ShardWorker {
  id: string;
  /** Environment compatibility key for historical durations (e.g. os+renderer). */
  envKey: string;
  capabilities: WorkerCapabilities;
}

export interface PlanInputs {
  manifest: ShardManifest;
  /** Tests selected by change-impact selection (#53). */
  selected: string[];
  workers: ShardWorker[];
  /** envKey -> testId -> last observed duration (ms). */
  history?: Record<string, Record<string, number>>;
  commit: string;
  policyRevision: string;
  /** Opt in; sharding is off by default. */
  optIn: boolean;
  /** Fixed cost of a partition (queue + transfer), ms. */
  partitionOverheadMs?: number;
  maxPartitions?: number;
  defaultDurationMs?: number;
}

export interface PlanUnit {
  id: string;
  testIds: string[];
  predictedMs: number;
  requires: JobRequirements;
  reasons: ReasonCode[];
}

export interface PlanPartition {
  id: string;
  /** Absent for the full-suite fallback. */
  workerId?: string;
  envKey?: string;
  units: PlanUnit[];
  testIds: string[];
  predictedMs: number;
  /** All tests idempotent: only then may the partition be retried. */
  idempotent: boolean;
}

export interface ShardPlan {
  version: number;
  planId: string;
  commit: string;
  manifestRevision: string;
  policyRevision: string;
  mode: 'sharded' | 'full-suite';
  fullSuiteCommand?: string;
  /** Mandatory-or-selected tests the run must account for. Empty in full-suite mode. */
  expectedTestIds: string[];
  mandatoryTestIds: string[];
  partitions: PlanPartition[];
  /** Tests no worker can run: they will be reported untested, never silently dropped. */
  unplaceable: { testId: string; reason: ReasonCode }[];
  testReasons: Record<string, ReasonCode[]>;
  predictedSerialMs: number;
  predictedMakespanMs: number;
  reasons: ReasonCode[];
}

const sortStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function mergeRequirements(tests: ShardTest[]): JobRequirements | null {
  const out: Record<string, unknown> = {};
  for (const t of tests) {
    for (const [k, v] of Object.entries(t.requires)) {
      if (v === undefined || v === false) continue;
      if (k in out && out[k] !== v) return null;
      out[k] = v;
    }
  }
  return out as JobRequirements;
}

/** Union-find over test ids so groups and shared setups form atomic units. */
function buildUnits(tests: ShardTest[]): Map<string, { tests: ShardTest[]; reasons: Set<ReasonCode> }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(sortStr(ra, rb) < 0 ? rb : ra, sortStr(ra, rb) < 0 ? ra : rb);
  };
  for (const t of tests) parent.set(t.id, t.id);
  const keyed = new Map<string, string>();
  const bind = (key: string, id: string) => {
    const first = keyed.get(key);
    if (first) union(first, id); else keyed.set(key, id);
  };
  const reasons = new Map<string, Set<ReasonCode>>();
  const note = (id: string, r: ReasonCode) => { (reasons.get(id) ?? reasons.set(id, new Set()).get(id)!).add(r); };
  for (const t of tests) {
    if (t.isolationGroup) { bind(`g:${t.isolationGroup}`, t.id); note(t.id, 'isolation-group'); }
    if (t.setup) { bind(`s:${t.setup}`, t.id); note(t.id, 'shared-setup'); }
    if (!t.parallelSafe) { bind('serial', t.id); note(t.id, 'not-parallel-safe'); }
    else if (!t.shardable && !t.isolationGroup && !t.setup) note(t.id, 'not-shardable');
    if (!t.shardable && (t.isolationGroup || t.setup || !t.parallelSafe)) note(t.id, 'not-shardable');
    if (t.parallelSafe && t.shardable && !t.isolationGroup && !t.setup) note(t.id, 'free');
  }
  // Tests that are parallel-safe but not shardable stay with their group only; alone they are a unit.
  const units = new Map<string, { tests: ShardTest[]; reasons: Set<ReasonCode> }>();
  for (const t of tests) {
    const root = find(t.id);
    const u = units.get(root) ?? { tests: [], reasons: new Set<ReasonCode>() };
    u.tests.push(t);
    for (const r of reasons.get(t.id) ?? []) u.reasons.add(r);
    units.set(root, u);
  }
  return units;
}

function fullSuite(inputs: PlanInputs, reason: ReasonCode, mandatory: string[]): ShardPlan {
  const body = {
    version: SHARD_PLAN_VERSION,
    commit: inputs.commit,
    manifestRevision: inputs.manifest.revision,
    policyRevision: inputs.policyRevision,
    mode: 'full-suite' as const,
    fullSuiteCommand: inputs.manifest.fullSuiteCommand,
    expectedTestIds: [] as string[],
    mandatoryTestIds: mandatory,
    partitions: [{ id: 'full-suite', units: [], testIds: [], predictedMs: 0, idempotent: false }],
    unplaceable: [],
    testReasons: {},
    predictedSerialMs: 0,
    predictedMakespanMs: 0,
    reasons: [reason],
  };
  return deepFreeze({ ...body, planId: hash(inputs, body) });
}

function hash(inputs: PlanInputs, body: unknown): string {
  return createHash('sha256').update(canonical({ i: { c: inputs.commit, p: inputs.policyRevision, m: inputs.manifest.revision }, body })).digest('hex').slice(0, 16);
}

export function planShards(inputs: PlanInputs): ShardPlan {
  const byId = new Map(inputs.manifest.tests.map((t) => [t.id, t]));
  const mandatory = inputs.manifest.tests.filter((t) => t.mandatory).map((t) => t.id).sort(sortStr);
  if (!inputs.optIn) return fullSuite(inputs, 'sharding-disabled', mandatory);
  if (inputs.manifest.discovery !== 'supported' || inputs.manifest.tests.length === 0) {
    return fullSuite(inputs, 'discovery-unsupported', mandatory);
  }

  const testReasons: Record<string, ReasonCode[]> = {};
  const expected = new Set<string>();
  for (const id of inputs.selected) {
    if (!byId.has(id)) throw new Error(`selected test is not in the manifest: ${id}`);
    expected.add(id);
  }
  for (const id of mandatory) {
    if (!expected.has(id)) { expected.add(id); testReasons[id] = ['mandatory-added']; }
  }
  const expectedIds = [...expected].sort(sortStr);
  const tests = expectedIds.map((id) => byId.get(id)!);
  const workers = [...inputs.workers].sort((a, b) => sortStr(a.id, b.id));
  const defaultMs = inputs.defaultDurationMs ?? 1000;
  const overhead = inputs.partitionOverheadMs ?? 0;

  const unplaceable: ShardPlan['unplaceable'] = [];
  type RawUnit = { id: string; tests: ShardTest[]; reasons: Set<ReasonCode>; requires: JobRequirements; compatible: ShardWorker[] };
  const raw: RawUnit[] = [];
  for (const [root, u] of buildUnits(tests)) {
    const requires = mergeRequirements(u.tests);
    const ids = u.tests.map((t) => t.id).sort(sortStr);
    if (!requires) {
      for (const id of ids) unplaceable.push({ testId: id, reason: 'conflicting-requirements' });
      continue;
    }
    const compatible = workers.filter((w) => matchRequirements(w.capabilities, requires).schedulable);
    if (!compatible.length) {
      for (const id of ids) unplaceable.push({ testId: id, reason: 'no-compatible-worker' });
      continue;
    }
    raw.push({ id: `unit:${root}`, tests: u.tests, reasons: u.reasons, requires, compatible });
  }
  unplaceable.sort((a, b) => sortStr(a.testId, b.testId));

  const duration = (t: ShardTest, w: ShardWorker): { ms: number; code: ReasonCode } => {
    if (t.durationMsOverride) return { ms: t.durationMsOverride, code: 'override' };
    const h = inputs.history?.[w.envKey]?.[t.id];
    if (h !== undefined && h > 0) return { ms: h, code: 'history' };
    return { ms: defaultMs, code: 'fallback-default' };
  };
  const unitMs = (u: RawUnit, w: ShardWorker) => u.tests.reduce((s, t) => s + duration(t, w).ms, 0);
  // Order by predicted work on the first compatible worker, longest first; id breaks ties.
  const ordered = raw
    .map((u) => ({ u, ms: unitMs(u, u.compatible[0]) }))
    .sort((a, b) => b.ms - a.ms || sortStr(a.u.id, b.u.id));

  const place = (pool: ShardWorker[]) => {
    const load = new Map(pool.map((w) => [w.id, 0]));
    const assigned = new Map<string, RawUnit[]>(pool.map((w) => [w.id, []]));
    const skipped: RawUnit[] = [];
    for (const { u } of ordered) {
      const options = u.compatible.filter((w) => load.has(w.id));
      if (!options.length) { skipped.push(u); continue; }
      let best = options[0], bestEnd = Infinity;
      for (const w of options) {
        const end = (load.get(w.id) ?? 0) + unitMs(u, w);
        if (end < bestEnd) { best = w; bestEnd = end; }
      }
      load.set(best.id, bestEnd);
      assigned.get(best.id)!.push(u);
    }
    const used = pool.filter((w) => assigned.get(w.id)!.length);
    const makespan = Math.max(0, ...used.map((w) => (load.get(w.id) ?? 0) + overhead));
    return { assigned, used, makespan, skipped };
  };

  // Choose how many workers to use: more workers only while the predicted wall-time gain exceeds the extra partition's overhead.
  const cap = Math.max(1, Math.min(inputs.maxPartitions ?? workers.length, workers.length));
  let chosen = place(workers.slice(0, 1));
  let capped = false;
  for (let k = 2; k <= cap; k++) {
    const trial = place(workers.slice(0, k));
    if (trial.skipped.length < chosen.skipped.length || trial.makespan + overhead < chosen.makespan) chosen = trial; else capped = true;
  }
  // Units that only an excluded worker can run: fall back to the full pool.
  if (chosen.skipped.length) chosen = place(workers.slice(0, cap));

  const partitions: PlanPartition[] = [];
  for (const w of chosen.used) {
    const units: PlanUnit[] = chosen.assigned.get(w.id)!.map((u) => {
      const ids = u.tests.map((t) => t.id).sort(sortStr);
      const codes = new Set<ReasonCode>(u.reasons);
      for (const t of u.tests) {
        const d = duration(t, w);
        codes.add(d.code);
        testReasons[t.id] = [...new Set([...(testReasons[t.id] ?? []), ...[...u.reasons].sort(sortStr), d.code])];
      }
      return { id: u.id, testIds: ids, predictedMs: unitMs(u, w), requires: u.requires, reasons: [...codes].sort(sortStr) };
    });
    const testIds = units.flatMap((u) => u.testIds);
    partitions.push({
      id: `p${partitions.length + 1}`,
      workerId: w.id,
      envKey: w.envKey,
      units,
      testIds,
      predictedMs: units.reduce((s, u) => s + u.predictedMs, 0) + overhead,
      idempotent: testIds.every((id) => byId.get(id)!.idempotent),
    });
  }
  for (const u of chosen.skipped) for (const t of u.tests) unplaceable.push({ testId: t.id, reason: 'no-compatible-worker' });

  const serial = partitions.reduce((s, p) => s + p.predictedMs - overhead, 0);
  const body = {
    version: SHARD_PLAN_VERSION,
    commit: inputs.commit,
    manifestRevision: inputs.manifest.revision,
    policyRevision: inputs.policyRevision,
    mode: 'sharded' as const,
    expectedTestIds: expectedIds,
    mandatoryTestIds: mandatory,
    partitions,
    unplaceable,
    testReasons: Object.fromEntries(Object.keys(testReasons).sort(sortStr).map((k) => [k, testReasons[k]])),
    predictedSerialMs: serial,
    predictedMakespanMs: Math.max(0, ...partitions.map((p) => p.predictedMs)),
    reasons: capped ? (['overhead-cap'] as ReasonCode[]) : [],
  };
  return deepFreeze({ ...body, planId: hash(inputs, body) });
}

export interface PartitionRuntimeState {
  state: 'pending' | 'started' | 'finished';
  attempt: number;
}

/** A never-started partition may move to another compatible worker; a started one never does. */
export function reassignPartition(
  plan: ShardPlan,
  partitionId: string,
  runtime: PartitionRuntimeState,
  candidates: ShardWorker[],
  requirementsOf: (testId: string) => JobRequirements,
): { ok: true; workerId: string } | { ok: false; reason: 'started' | 'unknown-partition' | 'no-compatible-worker' } {
  const p = plan.partitions.find((x) => x.id === partitionId);
  if (!p) return { ok: false, reason: 'unknown-partition' };
  if (runtime.state !== 'pending') return { ok: false, reason: 'started' };
  const ok = [...candidates].sort((a, b) => sortStr(a.id, b.id)).find((w) =>
    w.id !== p.workerId && p.testIds.every((id) => matchRequirements(w.capabilities, requirementsOf(id)).schedulable));
  return ok ? { ok: true, workerId: ok.id } : { ok: false, reason: 'no-compatible-worker' };
}

/** Bounded retry: idempotent partitions only, always under a new attempt number. */
export function planRetry(
  plan: ShardPlan,
  partitionId: string,
  runtime: PartitionRuntimeState,
  maxAttempts = 2,
): { ok: true; attempt: number } | { ok: false; reason: 'not-idempotent' | 'attempts-exhausted' | 'unknown-partition' | 'still-running' } {
  const p = plan.partitions.find((x) => x.id === partitionId);
  if (!p) return { ok: false, reason: 'unknown-partition' };
  if (runtime.state === 'started') return { ok: false, reason: 'still-running' };
  if (!p.idempotent) return { ok: false, reason: 'not-idempotent' };
  if (runtime.attempt >= maxAttempts) return { ok: false, reason: 'attempts-exhausted' };
  return { ok: true, attempt: runtime.attempt + 1 };
}
