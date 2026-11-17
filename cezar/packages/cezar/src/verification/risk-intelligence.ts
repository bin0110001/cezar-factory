import { createHash } from 'node:crypto';

/**
 * Historical file/module/contract risk intelligence (#660). Deterministic, project-scoped and explainable: it turns observed
 * events (regressions, reopenings, reverts, remediation, verification failures, merge conflicts, security findings, flakiness) and
 * change history into versioned risk evidence that an existing classifier, impact manifest or scheduling policy can consume. It is
 * not a scheduler or a second classifier, and final enforcement never goes to a model: sensitive paths carry mandatory floors that
 * do not depend on incident history, and `enforceFloor` can only raise a level.
 *
 * Observation is not attribution. A failing run that touched several files proves little about each; the score shares the incident
 * across the files, caps unattributed multi-file incidents as hypotheses, and carries a confidence and the evidence behind it.
 */

export const RISK_SCHEMA_VERSION = 1;
export const RISK_POLICY_VERSION = 'risk-policy-1';
const DAY = 86_400_000;

export const EVENT_KINDS = ['regression', 'reopening', 'revert', 'remediation', 'verification-failure', 'merge-conflict', 'security-finding', 'flaky'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface RiskEvent {
  id: string;
  repo: string;
  kind: EventKind;
  at: string;
  /** Files touched by the failing run or change that produced the event. */
  files: readonly string[];
  /** Canonical incident key. Many events with the same key (100 reruns of one failure) are one incident. */
  incident: string;
  /** Confirmed by deterministic validation or an authorized review, not merely observed. */
  confirmed: boolean;
  /** A confirmed cause when one is known; otherwise the incident is shared across `files`. */
  attributedTo?: string;
  resolvedAt?: string;
  commit?: string;
}

export interface ChangeRecord { repo: string; file: string; at: string; commit: string }
export interface ContractDef { id: string; repo: string; files: readonly string[]; consumers: number }
export interface Rename { repo: string; from: string; to: string }

export interface RiskPolicy {
  version: string;
  /** Half-life of an incident's weight, in days. */
  halfLifeDays: number;
  /** An unresolved, confirmed, single-file incident weighs 1; these scale the other cases. */
  unattributedCap: number;
  resolvedFactor: number;
  /** Distinct incidents required before history can lift a file above `low`. */
  minEvidence: number;
  /** Level thresholds on the bounded 0..1 overall score. */
  thresholds: { medium: number; high: number };
  /** `low` raises the bar for history, `high` lowers it. */
  sensitivity: 'low' | 'normal' | 'high';
  /** Mandatory floors by path glob, independent of any incident count. */
  floors: ReadonlyArray<{ id: string; glob: string; level: RiskLevel; dimension: Dimension }>;
  /** Module = the first `moduleDepth` path segments. */
  moduleDepth: number;
}

export const DIMENSIONS = ['likelihood', 'impact', 'concurrency', 'security', 'verificationDifficulty'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type RiskLevel = 'low' | 'medium' | 'high';
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  version: RISK_POLICY_VERSION, halfLifeDays: 90, unattributedCap: 0.25, resolvedFactor: 0.5, minEvidence: 2,
  thresholds: { medium: 0.3, high: 0.6 }, sensitivity: 'normal', moduleDepth: 2,
  floors: [
    { id: 'authentication', glob: '**/auth/**', level: 'high', dimension: 'security' },
    { id: 'authorization', glob: '**/authz/**', level: 'high', dimension: 'security' },
    { id: 'secrets', glob: '**/secrets/**', level: 'high', dimension: 'security' },
    { id: 'release', glob: 'scripts/release/**', level: 'high', dimension: 'impact' },
    { id: 'migrations', glob: '**/migrations/**', level: 'high', dimension: 'impact' },
  ],
};

export interface DimensionScores { likelihood: number; impact: number; concurrency: number; security: number; verificationDifficulty: number }
export interface FileRisk {
  file: string;
  dimensions: DimensionScores;
  overall: number;
  level: RiskLevel;
  /** Distinct incidents (after dedupe) with any attribution to this file. */
  evidenceCount: number;
  confidence: 'low' | 'medium' | 'high';
  floors: string[];
  /** The highest mandatory floor that applies (history-independent), or `low` when none does. */
  floorLevel: RiskLevel;
  reasons: string[];
}
export interface RollupRisk { id: string; level: RiskLevel; overall: number; files: number; reasons: string[] }
export interface RiskEvidence {
  schemaVersion: number;
  policyVersion: string;
  repo: string;
  dryRun: boolean;
  files: FileRisk[];
  modules: RollupRisk[];
  contracts: RollupRisk[];
  digest: string;
}

const globRx = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0000/g, '.*')}$`);
const bounded = (x: number) => Math.round((1 - Math.exp(-Math.max(0, x))) * 1000) / 1000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const levelOf = (score: number, p: RiskPolicy): RiskLevel => {
  const k = p.sensitivity === 'low' ? 1.25 : p.sensitivity === 'high' ? 0.8 : 1;
  return score >= p.thresholds.high * k ? 'high' : score >= p.thresholds.medium * k ? 'medium' : 'low';
};
const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

export interface RiskInput {
  repo: string;
  now: Date;
  events: readonly RiskEvent[];
  changes: readonly ChangeRecord[];
  contracts?: readonly ContractDef[];
  renames?: readonly Rename[];
  /** Paths changed by the change being assessed; a changed contract raises impact and concurrency regardless of failure history. */
  changedNow?: readonly string[];
  policy?: Partial<RiskPolicy>;
  dryRun?: boolean;
}

export function computeRisk(input: RiskInput): RiskEvidence {
  const p: RiskPolicy = { ...DEFAULT_RISK_POLICY, ...input.policy };
  const repo = input.repo;
  const now = input.now.getTime();

  // Follow renames so history survives a move; only this repository's renames apply.
  const renameMap = new Map(((input.renames ?? []).filter((r) => r.repo === repo)).map((r) => [r.from, r.to]));
  const canon = (f: string): string => { let cur = f; for (let i = 0; i < 20 && renameMap.has(cur); i++) cur = renameMap.get(cur) as string; return cur; };

  // Isolation: nothing from another repository can touch this one.
  const events = input.events.filter((e) => e.repo === repo);
  const changes = input.changes.filter((c) => c.repo === repo);
  const contracts = (input.contracts ?? []).filter((c) => c.repo === repo);

  // One incident however many times it was reported: keep the most informative event per incident key.
  const byIncident = new Map<string, RiskEvent>();
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const prior = byIncident.get(e.incident);
    if (!prior || (e.confirmed && !prior.confirmed) || (e.confirmed === prior.confirmed && e.files.length > 0 && e.files.length < prior.files.length)) byIncident.set(e.incident, e);
  }

  const acc = new Map<string, { likelihood: number; security: number; difficulty: number; incidents: Set<string>; confirmed: number; reasons: string[] }>();
  const slot = (f: string) => { let s = acc.get(f); if (!s) { s = { likelihood: 0, security: 0, difficulty: 0, incidents: new Set(), confirmed: 0, reasons: [] }; acc.set(f, s); } return s; };
  for (const e of [...byIncident.values()].sort((a, b) => a.incident.localeCompare(b.incident))) {
    const files = [...new Set(e.files.map(canon))].sort();
    if (files.length === 0) continue;
    const ageDays = Math.max(0, (now - Date.parse(e.at)) / DAY);
    let w = Math.pow(0.5, ageDays / p.halfLifeDays);            // time decay
    if (e.resolvedAt) w *= p.resolvedFactor;                      // resolved incidents decay but never vanish
    const attributed = e.attributedTo ? canon(e.attributedTo) : undefined;
    for (const f of files) {
      // Observation is not attribution: a confirmed cause takes the weight, otherwise it is shared and capped as a hypothesis.
      const share = attributed ? (f === attributed ? 1 : 0) : (files.length === 1 && e.confirmed ? 1 : Math.min(p.unattributedCap, 1 / files.length));
      if (share === 0) continue;
      const s = slot(f);
      s.incidents.add(e.incident);
      if (e.confirmed) s.confirmed++;
      const contribution = w * share;
      if (e.kind === 'security-finding') s.security += contribution;
      else if (e.kind === 'flaky') s.difficulty += contribution;
      else if (e.kind === 'verification-failure' && !e.confirmed) s.difficulty += contribution * 0.5;
      else s.likelihood += contribution * (e.kind === 'merge-conflict' ? 0.5 : 1);
      s.reasons.push(`${e.kind} ${e.incident}${attributed ? ' (attributed)' : files.length > 1 ? ` (shared across ${files.length} files)` : ''}`);
    }
  }

  // Churn: how often a file changes. It feeds concurrency only; a stable, frequently edited file is not penalised for churn.
  const churn = new Map<string, Set<string>>();
  for (const c of changes) {
    if (now - Date.parse(c.at) > 90 * DAY) continue;
    const f = canon(c.file);
    (churn.get(f) ?? churn.set(f, new Set()).get(f)!).add(c.commit);
  }
  const changedNow = new Set((input.changedNow ?? []).map(canon));
  const contractOf = new Map<string, ContractDef[]>();
  for (const c of contracts) for (const f of c.files) (contractOf.get(canon(f)) ?? contractOf.set(canon(f), []).get(canon(f))!).push(c);

  const universe = new Set<string>([...acc.keys(), ...churn.keys(), ...changedNow, ...contractOf.keys()]);
  const floors = p.floors.map((f) => ({ ...f, rx: globRx(f.glob) }));
  const files: FileRisk[] = [...universe].sort().map((file) => {
    const s = acc.get(file);
    const cs = contractOf.get(file) ?? [];
    const evidenceCount = s?.incidents.size ?? 0;
    const enough = evidenceCount >= p.minEvidence;
    // Below the minimum evidence, history is damped so one incident cannot make a file look risky.
    const damp = enough ? 1 : 0.4;
    const fan = cs.reduce((n, c) => n + c.consumers, 0);
    const dims: DimensionScores = {
      likelihood: bounded((s?.likelihood ?? 0) * damp),
      // Impact comes from consumer fan-out; a contract changed now raises it independently of failure rate.
      impact: bounded(fan / 20 + (cs.some((c) => c.files.some((cf) => changedNow.has(canon(cf)))) ? 0.5 : 0)),
      concurrency: bounded((churn.get(file)?.size ?? 0) / 25 + (changedNow.has(file) && cs.length > 0 ? 0.4 : 0)),
      security: bounded((s?.security ?? 0) * damp),
      verificationDifficulty: bounded((s?.difficulty ?? 0) * damp),
    };
    const hit = floors.filter((f) => f.rx.test(file));
    // Concurrency (churn, parallel change) is its own dimension for scheduling and conflict policy; it never raises the overall risk,
    // so a stable, frequently edited file is not penalised for churn.
    let overall = Math.max(dims.likelihood, dims.impact * 0.9, dims.security, dims.verificationDifficulty * 0.8);
    let level = levelOf(overall, p);
    for (const f of hit) level = maxLevel(level, f.level);
    overall = r3(overall);
    const reasons = [...(s ? [...new Set(s.reasons)].sort().slice(0, 8) : [])];
    if (!enough && evidenceCount > 0) reasons.push(`only ${evidenceCount} distinct incident(s); minimum evidence is ${p.minEvidence}, so history is damped`);
    if (fan > 0) reasons.push(`part of ${cs.length} contract(s) with ${fan} consumer(s)`);
    for (const f of hit) reasons.push(`mandatory floor ${f.id}: ${f.level} regardless of history`);
    const confirmedShare = s && s.incidents.size > 0 ? s.confirmed / s.incidents.size : 0;
    return { file, dimensions: dims, overall, level, evidenceCount, confidence: evidenceCount === 0 ? 'low' : confirmedShare >= 0.75 && enough ? 'high' : confirmedShare >= 0.4 ? 'medium' : 'low', floors: hit.map((f) => f.id), floorLevel: hit.reduce<RiskLevel>((l, f) => maxLevel(l, f.level), 'low'), reasons };
  });

  const moduleOf = (f: string) => f.split('/').slice(0, p.moduleDepth).join('/') || '.';
  const roll = (groups: Map<string, FileRisk[]>, labelFor: (id: string) => string): RollupRisk[] =>
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, fs]) => {
      const overall = r3(Math.max(...fs.map((f) => f.overall)));
      const level = fs.reduce<RiskLevel>((l, f) => maxLevel(l, f.level), 'low');
      const worst = [...fs].sort((a, b) => b.overall - a.overall || a.file.localeCompare(b.file))[0] as FileRisk;
      return { id: labelFor(id), level, overall, files: fs.length, reasons: [`highest: ${worst.file} (${worst.level})`] };
    });
  const modules = new Map<string, FileRisk[]>();
  for (const f of files) (modules.get(moduleOf(f.file)) ?? modules.set(moduleOf(f.file), []).get(moduleOf(f.file))!).push(f);
  const contractGroups = new Map<string, FileRisk[]>();
  for (const c of contracts) {
    const fs = files.filter((f) => c.files.map(canon).includes(f.file));
    if (fs.length) contractGroups.set(c.id, fs);
  }

  const body = { schemaVersion: RISK_SCHEMA_VERSION, policyVersion: p.version, repo, dryRun: input.dryRun ?? true, files, modules: roll(modules, (x) => x), contracts: roll(contractGroups, (x) => x) };
  return { ...body, digest: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}` };
}

/** A model or classifier may suggest a level; mandatory floors from history-independent rules can only raise it. */
export function enforceFloor(suggested: RiskLevel, file: FileRisk): { level: RiskLevel; floored: boolean; floors: string[] } {
  const level = maxLevel(suggested, file.floorLevel);
  return { level, floored: LEVEL_RANK[level] > LEVEL_RANK[suggested], floors: file.floors };
}

export interface RiskOverride { file: string; level: RiskLevel; reason: string; actor: string; at: string }
export interface OverrideResult { level: RiskLevel; applied: boolean; audit: RiskOverride & { before: RiskLevel; refused?: string } }

/** Overrides are audited and can lower history-based risk, but never below a mandatory floor. */
export function applyOverride(file: FileRisk, o: RiskOverride): OverrideResult {
  const floor = file.floorLevel;
  if (!o.reason.trim() || !o.actor.trim()) return { level: file.level, applied: false, audit: { ...o, before: file.level, refused: 'an override needs an actor and a reason' } };
  if (LEVEL_RANK[o.level] < LEVEL_RANK[floor]) return { level: file.level, applied: false, audit: { ...o, before: file.level, refused: `below the mandatory floor (${file.floors.join(', ')})` } };
  return { level: o.level, applied: true, audit: { ...o, before: file.level } };
}

/** Minimum guards a policy can require from the evidence alone, with no model involved. */
export function minimumGuards(file: FileRisk): string[] {
  const guards: string[] = [];
  if (file.level === 'high') guards.push('full-regression', 'independent-review');
  else if (file.level === 'medium') guards.push('impacted-regression');
  if (file.dimensions.security >= 0.3 || file.floors.some((f) => ['authentication', 'authorization', 'secrets'].includes(f))) guards.push('security-scan');
  if (file.dimensions.impact >= 0.5) guards.push('consumer-compatibility-check');
  return [...new Set(guards)].sort();
}
