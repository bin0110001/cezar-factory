import type { ShardPlan } from './shard-planner.ts';

/**
 * Consolidates per-partition results into one run with a completeness ledger (#216).
 * Pass is only reachable when every mandatory expected test has a fresh, matching,
 * passing result. Missing, late, stale or canceled evidence never becomes green.
 */
export type TestStatus = 'pass' | 'fail' | 'skipped' | 'untested' | 'canceled' | 'infra' | 'inconclusive';
export type RunVerdict = 'pass' | 'fail' | 'infra' | 'incomplete';

export interface TestResult {
  id: string;
  status: TestStatus;
  durationMs?: number;
  artifactHashes?: string[];
}

export interface PartitionResult {
  partitionId: string;
  attempt: number;
  planId: string;
  commit: string;
  manifestRevision: string;
  workerId?: string;
  envKey?: string;
  /** How the partition ended; `completed` still requires per-test results. */
  outcome: 'completed' | 'canceled' | 'crashed' | 'timeout';
  tests: TestResult[];
  receivedAtMs?: number;
  wallMs?: number;
  queueMs?: number;
  transferMs?: number;
  /** Used by the full-suite fallback, which has no per-test ledger. */
  fullSuiteExitCode?: number;
}

export interface AggregateInputs {
  plan: ShardPlan;
  results: PartitionResult[];
  /** partitionId -> attempt currently authoritative (default 1). */
  currentAttempts?: Record<string, number>;
  /** Results received after this instant are late. */
  deadlineMs?: number;
}

export type RejectReason = 'stale-plan' | 'stale-revision' | 'stale-attempt' | 'late' | 'unknown-partition' | 'duplicate-conflict';

export interface LedgerEntry {
  testId: string;
  status: TestStatus;
  mandatory: boolean;
  partitionId?: string;
  attempt?: number;
  envKey?: string;
  workerId?: string;
  artifactHashes: string[];
  note?: string;
}

export interface AggregateReport {
  planId: string;
  commit: string;
  manifestRevision: string;
  policyRevision: string;
  verdict: RunVerdict;
  /** True only when verdict is `pass`. */
  verified: boolean;
  ledger: LedgerEntry[];
  counts: Record<TestStatus, number>;
  rejected: { partitionId: string; attempt: number; reason: RejectReason }[];
  unexpected: { partitionId: string; testId: string }[];
  lineage: { partitionId: string; attempt: number; workerId?: string; envKey?: string }[];
  timing: {
    serialMs: number; wallMs: number; overheadMs: number; speedup: number | null;
  };
  reasons: string[];
}

const emptyCounts = (): Record<TestStatus, number> => ({
  pass: 0, fail: 0, skipped: 0, untested: 0, canceled: 0, infra: 0, inconclusive: 0,
});

const sameTests = (a: TestResult[], b: TestResult[]) =>
  JSON.stringify([...a].sort((x, y) => (x.id < y.id ? -1 : 1))) === JSON.stringify([...b].sort((x, y) => (x.id < y.id ? -1 : 1)));

export function aggregateShardResults(input: AggregateInputs): AggregateReport {
  const { plan } = input;
  const rejected: AggregateReport['rejected'] = [];
  const accepted = new Map<string, PartitionResult>();
  const conflicted = new Set<string>();
  const partitions = new Map(plan.partitions.map((p) => [p.id, p]));

  for (const r of input.results) {
    const reject = (reason: RejectReason) => rejected.push({ partitionId: r.partitionId, attempt: r.attempt, reason });
    if (r.planId !== plan.planId || r.commit !== plan.commit) { reject('stale-plan'); continue; }
    if (r.manifestRevision !== plan.manifestRevision) { reject('stale-revision'); continue; }
    if (!partitions.has(r.partitionId)) { reject('unknown-partition'); continue; }
    if (r.attempt !== (input.currentAttempts?.[r.partitionId] ?? 1)) { reject('stale-attempt'); continue; }
    if (input.deadlineMs !== undefined && (r.receivedAtMs ?? 0) > input.deadlineMs) { reject('late'); continue; }
    const prior = accepted.get(r.partitionId);
    if (prior) {
      // Same attempt seen twice: identical is a harmless duplicate, different is untrustworthy.
      if (prior.outcome !== r.outcome || !sameTests(prior.tests, r.tests)) { conflicted.add(r.partitionId); reject('duplicate-conflict'); }
      continue;
    }
    accepted.set(r.partitionId, r);
  }

  const ledger: LedgerEntry[] = [];
  const unexpected: AggregateReport['unexpected'] = [];
  const reasons: string[] = [];
  const mandatory = new Set(plan.mandatoryTestIds);
  const unplaceable = new Map(plan.unplaceable.map((u) => [u.testId, u.reason]));

  if (plan.mode === 'full-suite') {
    const r = accepted.get('full-suite');
    let verdict: RunVerdict;
    if (!r) verdict = 'incomplete';
    else if (r.outcome !== 'completed') verdict = r.outcome === 'canceled' ? 'incomplete' : 'infra';
    else verdict = r.fullSuiteExitCode === 0 ? 'pass' : r.fullSuiteExitCode === undefined ? 'incomplete' : 'fail';
    return finish(plan, verdict, ledger, rejected, unexpected, accepted, reasons.concat(r ? [] : ['full-suite result missing']));
  }

  const expected = new Set(plan.expectedTestIds);
  const owner = new Map<string, string>();
  for (const p of plan.partitions) for (const id of p.testIds) owner.set(id, p.id);

  const byTest = new Map<string, { r: PartitionResult; t: TestResult }>();
  for (const r of accepted.values()) {
    if (conflicted.has(r.partitionId)) continue;
    for (const t of r.tests) {
      if (!expected.has(t.id) || owner.get(t.id) !== r.partitionId) { unexpected.push({ partitionId: r.partitionId, testId: t.id }); continue; }
      const prior = byTest.get(t.id);
      if (prior && prior.t.status !== t.status) { byTest.set(t.id, { r, t: { ...t, status: 'inconclusive' } }); continue; }
      byTest.set(t.id, { r, t });
    }
  }

  for (const id of plan.expectedTestIds) {
    const pid = owner.get(id);
    const base = { testId: id, mandatory: mandatory.has(id), partitionId: pid, artifactHashes: [] as string[] };
    const found = byTest.get(id);
    if (unplaceable.has(id)) { ledger.push({ ...base, status: 'untested', note: unplaceable.get(id) }); continue; }
    if (pid && conflicted.has(pid)) { ledger.push({ ...base, status: 'inconclusive', note: 'duplicate-conflict' }); continue; }
    const part = pid ? accepted.get(pid) : undefined;
    if (found) {
      // A passing test inside a partition that did not complete is not trusted.
      const status = found.r.outcome !== 'completed' && found.t.status === 'pass' ? 'inconclusive' : found.t.status;
      ledger.push({
        ...base, status, attempt: found.r.attempt, envKey: found.r.envKey, workerId: found.r.workerId,
        artifactHashes: [...(found.t.artifactHashes ?? [])].sort(),
        note: status !== found.t.status ? `partition-${found.r.outcome}` : undefined,
      });
    } else if (part) {
      const status: TestStatus = part.outcome === 'canceled' ? 'canceled' : part.outcome === 'completed' ? 'untested' : 'infra';
      ledger.push({ ...base, status, attempt: part.attempt, envKey: part.envKey, workerId: part.workerId, note: `partition-${part.outcome}` });
    } else {
      ledger.push({ ...base, status: 'untested', note: 'partition-missing' });
    }
  }

  const counts = emptyCounts();
  let verdict: RunVerdict = 'pass';
  const blockers = ledger.filter((e) => e.mandatory || e.status === 'fail');
  if (blockers.some((e) => e.status === 'fail')) verdict = 'fail';
  else if (blockers.some((e) => e.status === 'infra')) verdict = 'infra';
  else if (blockers.some((e) => e.status !== 'pass')) verdict = 'incomplete';
  else if (plan.expectedTestIds.length === 0 && plan.mandatoryTestIds.length === 0) verdict = 'incomplete';
  for (const e of ledger) counts[e.status]++;
  return finish(plan, verdict, ledger, rejected, unexpected, accepted, reasons, counts);
}

function finish(
  plan: ShardPlan, verdict: RunVerdict, ledger: LedgerEntry[], rejected: AggregateReport['rejected'],
  unexpected: AggregateReport['unexpected'], accepted: Map<string, PartitionResult>, reasons: string[],
  counts: Record<TestStatus, number> = emptyCounts(),
): AggregateReport {
  const results = [...accepted.values()].sort((a, b) => (a.partitionId < b.partitionId ? -1 : 1));
  const testMs = results.flatMap((r) => r.tests).reduce((s, t) => s + (t.durationMs ?? 0), 0);
  const wallMs = Math.max(0, ...results.map((r) => r.wallMs ?? 0));
  const overheadMs = results.reduce((s, r) => s + (r.queueMs ?? 0) + (r.transferMs ?? 0), 0);
  return {
    planId: plan.planId, commit: plan.commit, manifestRevision: plan.manifestRevision, policyRevision: plan.policyRevision,
    verdict, verified: verdict === 'pass', ledger, counts, rejected, unexpected,
    lineage: results.map((r) => ({ partitionId: r.partitionId, attempt: r.attempt, workerId: r.workerId, envKey: r.envKey })),
    timing: { serialMs: testMs, wallMs, overheadMs, speedup: wallMs > 0 && testMs > 0 ? testMs / wallMs : null },
    reasons,
  };
}
