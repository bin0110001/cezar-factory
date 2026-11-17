import { z } from 'zod';

/**
 * Maintainability metrics (#649): complexity, duplication, dead code, warnings and coverage change, recorded per SHA from each
 * ecosystem's own tools. Metrics are quality debt by construction: they are never findings with a security severity, they can
 * only produce `low` or `medium` quality-debt signals, and they never contribute to a security gate.
 */

export const METRIC_NAMES = ['complexity', 'duplication', 'dead-code', 'warnings', 'coverage'] as const;
export const metricSampleSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  name: z.enum(METRIC_NAMES),
  /** `repo` for a whole-project figure, otherwise a repository-relative path. */
  scope: z.string().min(1).max(1024),
  value: z.number().finite(),
  unit: z.enum(['score', 'percent', 'count']),
  tool: z.string().min(1).max(64),
  toolVersion: z.string().min(1).max(64),
}).strict();
export type MetricSample = z.infer<typeof metricSampleSchema>;

/** Metrics are always classified as quality debt, regardless of what any tool calls them. */
export const METRIC_CLASS = 'quality-debt' as const;

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface ParseContext { sha: string; tool: string; toolVersion: string; root?: string }
const base = (c: ParseContext) => ({ sha: c.sha, tool: c.tool, toolVersion: c.toolVersion });
const rel = (p: string, root = ''): string => {
  const n = p.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return r && n.startsWith(`${r}/`) ? n.slice(r.length + 1) : n;
};

/** `[{ path, function, complexity }]`: one sample per function, scoped as `path#function`. */
export function parseComplexity(json: string, c: ParseContext): MetricSample[] {
  const items = JSON.parse(json) as unknown;
  if (!Array.isArray(items)) throw new Error('complexity report is not a list');
  return items.map(o).map((i) => metricSampleSchema.parse({
    ...base(c), name: 'complexity', scope: `${rel(String(i.path ?? ''), c.root)}#${String(i.function ?? 'anonymous')}`, value: Number(i.complexity), unit: 'score',
  }));
}

/** jscpd-style `{ statistics: { total: { percentage } } }` for the repo, plus optional per-file `{ duplicates: [{ file, lines }] }`. */
export function parseDuplication(json: string, c: ParseContext): MetricSample[] {
  const doc = o(JSON.parse(json));
  const pct = o(o(o(doc.statistics).total)).percentage;
  if (typeof pct !== 'number') throw new Error('duplication report has no total percentage');
  return [metricSampleSchema.parse({ ...base(c), name: 'duplication', scope: 'repo', value: pct, unit: 'percent' })];
}

/** `{ items: [{ path }] }`: unused code, counted per file and for the repository. */
export function parseDeadCode(json: string, c: ParseContext): MetricSample[] {
  const items = arr(o(JSON.parse(json)).items).map(o);
  const per = new Map<string, number>();
  for (const i of items) per.set(rel(String(i.path ?? ''), c.root), (per.get(rel(String(i.path ?? ''), c.root)) ?? 0) + 1);
  return [
    metricSampleSchema.parse({ ...base(c), name: 'dead-code', scope: 'repo', value: items.length, unit: 'count' }),
    ...[...per].map(([scope, n]) => metricSampleSchema.parse({ ...base(c), name: 'dead-code', scope, value: n, unit: 'count' })),
  ];
}

/** Compiler/analyzer warnings counted from a list of diagnostics `{ severity }`. */
export function parseWarnings(json: string, c: ParseContext): MetricSample[] {
  const items = arr(JSON.parse(json)).map(o);
  const n = items.filter((i) => String(i.severity ?? '').toLowerCase().startsWith('warn')).length;
  return [metricSampleSchema.parse({ ...base(c), name: 'warnings', scope: 'repo', value: n, unit: 'count' })];
}

/** Coverage summary `{ lines: { pct } }` (istanbul/coverage.py style). */
export function parseCoverage(json: string, c: ParseContext): MetricSample[] {
  const pct = o(o(JSON.parse(json)).lines).pct;
  if (typeof pct !== 'number') throw new Error('coverage summary has no line percentage');
  return [metricSampleSchema.parse({ ...base(c), name: 'coverage', scope: 'repo', value: pct, unit: 'percent' })];
}

/** Samples recorded per SHA. A sample is immutable: recording a different value for the same key is refused. */
export class MetricStore {
  private readonly bySha = new Map<string, Map<string, MetricSample>>();

  record(samples: readonly MetricSample[]): void {
    for (const raw of samples) {
      const s = metricSampleSchema.parse(raw);
      const shaMap = this.bySha.get(s.sha) ?? new Map<string, MetricSample>();
      const key = `${s.name}\u0000${s.scope}\u0000${s.tool}`;
      const prior = shaMap.get(key);
      if (prior && prior.value !== s.value) throw new Error(`metric ${s.name} for ${s.scope} at ${s.sha} is already recorded with a different value`);
      shaMap.set(key, s);
      this.bySha.set(s.sha, shaMap);
    }
  }

  forSha(sha: string): MetricSample[] {
    return [...(this.bySha.get(sha)?.values() ?? [])];
  }

  /** Repo-level value of a metric at a SHA (first tool wins deterministically by tool name). */
  repoValue(sha: string, name: MetricSample['name']): number | undefined {
    return this.forSha(sha).filter((s) => s.name === name && s.scope === 'repo').sort((a, b) => a.tool.localeCompare(b.tool))[0]?.value;
  }
}

export interface CoverageDelta { baseline: number; current: number; delta: number; regressed: boolean }

/** Coverage change against a baseline SHA. A drop beyond `tolerance` percentage points is a regression (quality debt, not security). */
export function coverageDelta(store: MetricStore, baselineSha: string, currentSha: string, tolerance = 0): CoverageDelta | undefined {
  const b = store.repoValue(baselineSha, 'coverage');
  const c = store.repoValue(currentSha, 'coverage');
  if (b === undefined || c === undefined) return undefined;
  const delta = Math.round((c - b) * 100) / 100;
  return { baseline: b, current: c, delta, regressed: delta < -tolerance };
}

export interface MetricThresholds { complexityMedium?: number; complexityLow?: number; duplicationPercent?: number; deadCodeCount?: number; warningCount?: number }
export interface QualityDebtSignal { metric: MetricSample['name']; scope: string; severity: 'low' | 'medium'; class: typeof METRIC_CLASS; message: string }

/** Threshold breaches as quality-debt signals. Severity is capped at `medium`: a metric can never look like a security finding. */
export function debtSignals(samples: readonly MetricSample[], t: MetricThresholds): QualityDebtSignal[] {
  const out: QualityDebtSignal[] = [];
  const add = (s: MetricSample, severity: 'low' | 'medium', message: string) => out.push({ metric: s.name, scope: s.scope, severity, class: METRIC_CLASS, message });
  for (const s of samples) {
    if (s.name === 'complexity') {
      if (t.complexityMedium !== undefined && s.value >= t.complexityMedium) add(s, 'medium', `complexity ${s.value} at or above ${t.complexityMedium}`);
      else if (t.complexityLow !== undefined && s.value >= t.complexityLow) add(s, 'low', `complexity ${s.value} at or above ${t.complexityLow}`);
    } else if (s.name === 'duplication' && s.scope === 'repo' && t.duplicationPercent !== undefined && s.value >= t.duplicationPercent) {
      add(s, 'low', `duplication ${s.value}% at or above ${t.duplicationPercent}%`);
    } else if (s.name === 'dead-code' && s.scope === 'repo' && t.deadCodeCount !== undefined && s.value >= t.deadCodeCount) {
      add(s, 'low', `${s.value} unused items`);
    } else if (s.name === 'warnings' && s.scope === 'repo' && t.warningCount !== undefined && s.value >= t.warningCount) {
      add(s, 'low', `${s.value} warnings`);
    }
  }
  return out;
}
