import { projectScenario, type OutcomeKind, type RolePartition, type ScenarioView } from './scenario-operations.ts';
import { redactError } from './worker-read-model.ts';

/**
 * Run/verification view composition (#219, slice 3). Pure: composes scenario
 * projections into the existing run page model with a per-shard/role timeline,
 * topology requirements, performance baselines, last successful run, permission
 * scoped artifact links and diagnostic-only trace correlation. No store, no
 * scheduler, no media bytes.
 */

export const RUN_VIEW_VERSION = 1;

export interface RunHistoryEntry {
  runId: string;
  outcome: OutcomeKind;
  finishedAt?: string;
  durationMs?: number;
}

export interface TopologyRequirement {
  role: string;
  /** Abstract capability tags only (e.g. "gpu", "display"); never hostnames or addresses. */
  requires: string[];
  /** Minimum distinct physical hosts the scenario needs. */
  minHosts?: number;
}

export interface ArtifactRef {
  id: string;
  kind: 'screenshot' | 'video' | 'trace' | 'log' | 'other';
  /** Permission needed to open it; links are omitted without it. */
  permission: string;
}

export interface TimelineEntry {
  shard: string;
  role: string;
  state: string;
  outcome: OutcomeKind;
  startedAt: string | null;
  finishedAt: string | null;
  workerDisconnected: boolean;
}

export interface RunVerificationView {
  schemaVersion: typeof RUN_VIEW_VERSION;
  runId: string;
  scenario: ScenarioView;
  timeline: TimelineEntry[];
  topology: { requirements: TopologyRequirement[]; hostsUsed: number; satisfied: boolean | 'unknown' };
  failureClass: 'none' | 'infra' | 'assertion' | 'both';
  baseline: { medianMs: number | null; samples: number; currentMs: number | null; regression: boolean | 'unknown' };
  lastSuccessfulRun: RunHistoryEntry | null;
  artifacts: { visible: ArtifactRef[]; hiddenCount: number; truncated: boolean };
  /** Diagnostic correlation only; never evidence of a result. */
  traces: { authoritative: false; ids: string[] };
  /** Roles with disconnects or missing captures, never shown as healthy. */
  warnings: string[];
}

const MAX_ARTIFACTS = 50;
const REGRESSION_FACTOR = 1.25;
const MIN_BASELINE_SAMPLES = 3;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function buildRunVerificationView(input: {
  runId: string;
  scenarioId: string;
  expectedRoles: string[];
  partitions: RolePartition[];
  queueReasons?: Record<string, string>;
  /** Worker ids currently stale/offline/unknown/revoked. */
  unhealthyWorkers?: string[];
  topology?: TopologyRequirement[];
  /** Prior runs of the same scenario, comparable baseline source. */
  history?: RunHistoryEntry[];
  artifacts?: ArtifactRef[];
  /** Permissions held by the viewer. */
  permissions?: string[];
}): RunVerificationView {
  const scenario = projectScenario(input.runId, input.scenarioId, input.expectedRoles, input.partitions, input.queueReasons);
  const bad = new Set(input.unhealthyWorkers ?? []);
  const mine = input.partitions.filter((p) => p.runId === input.runId && p.scenarioId === input.scenarioId);
  const byKey = new Map(mine.map((p) => [`${p.shard}:${p.role}`, p]));

  const timeline: TimelineEntry[] = scenario.partitions.map((v) => {
    const p = byKey.get(`${v.shard}:${v.role}`);
    return {
      shard: v.shard,
      role: v.role,
      state: v.state,
      outcome: v.outcome,
      startedAt: p?.startedAt ?? null,
      finishedAt: p?.finishedAt ?? null,
      workerDisconnected: v.workerId !== null && bad.has(v.workerId) && v.state === 'running',
    };
  }).sort((a, b) => (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿') || a.shard.localeCompare(b.shard) || a.role.localeCompare(b.role));

  const warnings: string[] = [];
  for (const t of timeline) {
    if (t.workerDisconnected) warnings.push(`${t.shard}/${t.role}: worker disconnected`);
  }
  for (const v of scenario.partitions) {
    if (v.missingEvidence.length) warnings.push(`${v.shard}/${v.role}: missing ${v.missingEvidence.join(', ')}`);
  }
  for (const r of scenario.coverage.missingRoles) warnings.push(`role ${r}: no complete result`);

  const requirements = input.topology ?? [];
  const hostsUsed = new Set(mine.map((p) => p.workerId).filter((w): w is string => !!w)).size;
  const needed = Math.max(0, ...requirements.map((r) => r.minHosts ?? 0));
  const topoKnown = requirements.length > 0 && mine.every((p) => p.workerId);
  const satisfied: boolean | 'unknown' = !topoKnown ? 'unknown' : hostsUsed >= needed;

  const failureClass = scenario.infraFailures && scenario.assertionFailures ? 'both'
    : scenario.infraFailures ? 'infra' : scenario.assertionFailures ? 'assertion' : 'none';

  // Baselines only from passing runs; infra/assertion failures are not comparable.
  const passing = (input.history ?? []).filter((h) => h.outcome === 'pass' && h.runId !== input.runId && typeof h.durationMs === 'number');
  const base = median(passing.map((h) => h.durationMs!));
  const durations = scenario.partitions.map((p) => p.durationMs).filter((d): d is number => d !== null);
  const currentMs = scenario.coverage.complete && durations.length ? Math.max(...durations) : null;
  const regression: boolean | 'unknown' = base === null || currentMs === null || passing.length < MIN_BASELINE_SAMPLES
    ? 'unknown' : currentMs > base * REGRESSION_FACTOR;

  const last = (input.history ?? [])
    .filter((h) => h.outcome === 'pass' && h.runId !== input.runId)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0] ?? null;

  const perms = new Set(input.permissions ?? []);
  const all = input.artifacts ?? [];
  const allowed = all.filter((a) => perms.has(a.permission));
  const visible = allowed.slice(0, MAX_ARTIFACTS);

  return {
    schemaVersion: RUN_VIEW_VERSION,
    runId: input.runId,
    scenario,
    timeline,
    topology: { requirements, hostsUsed, satisfied },
    failureClass,
    baseline: { medianMs: base, samples: passing.length, currentMs, regression },
    lastSuccessfulRun: last,
    artifacts: { visible, hiddenCount: all.length - allowed.length, truncated: allowed.length > visible.length },
    traces: {
      authoritative: false,
      ids: [...new Set(scenario.partitions.map((p) => p.traceId).filter((t): t is string => !!t))],
    },
    warnings: warnings.map((w) => redactError(w) ?? w),
  };
}
