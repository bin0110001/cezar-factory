import { createHash } from 'node:crypto';
import { analyzeOverlap, type OverlapLevel, type OverlapPolicy, DEFAULT_OVERLAP_POLICY } from '../impact/overlap.ts';
import type { ImpactManifest } from '../impact/manifest.ts';
import type { RankedCandidate } from './ranking.ts';

/**
 * Unified admission decision (#198). A pure function of explicit, revision-stamped inputs, so a
 * replay with the same inputs yields the same decision. It composes — and never replaces — the
 * existing #159 dependency gate and #93 quota gate: their verdicts arrive as inputs.
 */
export type DecisionKind = 'RUN' | 'DEFER' | 'BATCH' | 'COORDINATE' | 'INTEGRATE';

/** Distinct, documented reason codes. Quota, blockers and conflicts never share a status. */
export type ReasonCode =
  | 'ok' | 'not-ready' | 'on-hold' | 'blocked-dependency' | 'unknown-dependency' | 'approval-required'
  | 'owned-elsewhere' | 'quota-exhausted' | 'capacity-unknown' | 'wip-limit' | 'wip-reserved'
  | 'conflict-file' | 'conflict-contract' | 'conflict-unknown' | 'module-overlap' | 'forced-overlap' | 'shadow';

export interface DependencyVerdict { status: 'ready' | 'blocked' | 'unknown'; blockers: string[]; graphRevision: number }
export interface CapacityVerdict { status: 'available' | 'exhausted' | 'unknown'; resetAt?: string; revision?: string }
export interface RunningWork { id: string; repository: string; module?: string; manifest?: ImpactManifest; risk?: 'low' | 'medium' | 'high' }

export interface SchedulingContext {
  candidate: RankedCandidate;
  dependency: DependencyVerdict;
  approvalRequired?: boolean;
  /** Worktree/issue owner other than this scheduler (e.g. an interactive developer). */
  ownedBy?: string | null;
  capacity: CapacityVerdict;
  manifest?: ImpactManifest | null;
  /** Manifest freshness as judged by the caller against the current branch head. */
  manifestStale?: boolean;
  /** Audited human decision to run despite file/contract overlap; forces an integration obligation. */
  forceOverlap?: { actor: string; reason: string } | null;
}

export interface SchedulingConfig {
  /** Per-project kill switch: when false every decision is shadow-only. */
  enforce: boolean;
  maxParallel: number;
  maxPerRepository: number;
  /** Slots only P0/P1 (or expedited) work may occupy. */
  reservedHighPrioritySlots: number;
  overlap: OverlapPolicy;
  version: number;
}
export const DEFAULT_SCHEDULING_CONFIG: SchedulingConfig = { enforce: false, maxParallel: 3, maxPerRepository: 2, reservedHighPrioritySlots: 1, overlap: DEFAULT_OVERLAP_POLICY, version: 1 };

export interface SchedulingDecision {
  id: string;
  kind: DecisionKind;
  reason: ReasonCode;
  detail: string;
  /** Candidates sharing the round that were admitted together (BATCH). */
  batchWith: string[];
  /** For COORDINATE/INTEGRATE: the running work that is affected. */
  affects: string[];
  conflict: { level: OverlapLevel; confidence: number } | null;
  /** Idempotency key for the integration obligation (INTEGRATE only). */
  obligationKey: string | null;
  /** Shadow mode records what would happen but must not reserve anything. */
  shadow: boolean;
  /** Stable key over every revision that influenced this decision, for replay and dedupe. */
  decisionKey: string;
  sources: { configVersion: number; scoreConfigVersion: number; graphRevision: number; manifestRevision: number | null; capacityRevision: string | null };
}

function highPriority(c: RankedCandidate): boolean { return c.record.expedite || c.record.basePriority === 'P0' || c.record.basePriority === 'P1'; }

function keyOf(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24); }

/** Stable, order-independent key for an overlap between two issues (idempotent obligation identity). */
export function obligationKey(a: string, b: string): string { return `integration:${[a, b].sort().join('+')}`; }

function build(ctx: SchedulingContext, config: SchedulingConfig, running: RunningWork[], kind: DecisionKind, reason: ReasonCode, detail: string, extra: Partial<SchedulingDecision> = {}): SchedulingDecision {
  const id = ctx.candidate.id;
  return {
    id, kind, reason, detail, batchWith: [], affects: [], conflict: null, obligationKey: null,
    shadow: !config.enforce,
    decisionKey: keyOf([id, kind, reason, config.version, ctx.candidate.configVersion, ctx.dependency.graphRevision, ctx.manifest?.manifestRevision ?? null, ctx.capacity.revision ?? null, running.map((r) => r.id).sort()]),
    sources: { configVersion: config.version, scoreConfigVersion: ctx.candidate.configVersion, graphRevision: ctx.dependency.graphRevision, manifestRevision: ctx.manifest?.manifestRevision ?? null, capacityRevision: ctx.capacity.revision ?? null },
    ...extra,
  };
}

/** Decide one candidate against the work already running (including work admitted earlier this round). */
export function decideOne(ctx: SchedulingContext, running: RunningWork[], config = DEFAULT_SCHEDULING_CONFIG): SchedulingDecision {
  const defer = (reason: ReasonCode, detail: string, extra: Partial<SchedulingDecision> = {}) => build(ctx, config, running, 'DEFER', reason, detail, extra);
  const c = ctx.candidate;
  // Stage 1: lane / Ready / human hold
  if (!c.eligible) return defer(c.record.hold ? 'on-hold' : 'not-ready', c.gates.join('; '));
  // Stage 2: hard dependencies — fail closed on unknown
  if (ctx.dependency.status === 'blocked') return defer('blocked-dependency', `blocked by ${ctx.dependency.blockers.join(', ')}`);
  if (ctx.dependency.status === 'unknown') return defer('unknown-dependency', 'dependency graph cannot prove the issue unblocked');
  // Stage 3: policy / approval
  if (ctx.approvalRequired) return defer('approval-required', 'risky change awaits approval');
  // Stage 4: repo / worktree ownership
  if (ctx.ownedBy) return defer('owned-elsewhere', `issue is owned by ${ctx.ownedBy}`);
  // Stage 5: capacity (distinct statuses for quota vs WIP vs unknown)
  if (ctx.capacity.status === 'exhausted') return defer('quota-exhausted', ctx.capacity.resetAt ? `quota resets ${ctx.capacity.resetAt}` : 'quota exhausted');
  if (ctx.capacity.status === 'unknown') return defer('capacity-unknown', 'capacity could not be verified');
  if (running.length >= config.maxParallel) return defer('wip-limit', `${running.length}/${config.maxParallel} slots in use`);
  if (running.filter((r) => r.repository.toLowerCase() === c.record.repository.toLowerCase()).length >= config.maxPerRepository) return defer('wip-limit', `repository already has ${config.maxPerRepository} running`);
  if (!highPriority(c) && running.length >= config.maxParallel - config.reservedHighPrioritySlots) return defer('wip-reserved', 'remaining slots are reserved for P0/P1/expedited work');
  // Stage 6: conflict classification against running work
  let worst: { level: OverlapLevel; confidence: number; other: string } | null = null;
  const order: OverlapLevel[] = ['none', 'module', 'unknown', 'file', 'contract'];
  const affected: string[] = [];
  const mine = ctx.manifest ?? null;
  for (const other of running) {
    if (other.repository.toLowerCase() !== c.record.repository.toLowerCase()) continue;
    let level: OverlapLevel; let confidence: number;
    if (!mine || !other.manifest) { level = 'unknown'; confidence = 0.5; }
    else {
      const r = analyzeOverlap(mine, other.manifest, config.overlap);
      level = r.level; confidence = r.confidence;
      // A stale manifest cannot vouch for "no overlap".
      if (ctx.manifestStale && level === 'none') { level = 'unknown'; confidence = Math.min(confidence, 0.5); }
    }
    if (level !== 'none') affected.push(other.id);
    if (level !== 'none' && (!worst || order.indexOf(level) > order.indexOf(worst.level))) worst = { level, confidence, other: other.id };
  }
  if (worst && (worst.level === 'file' || worst.level === 'contract' || worst.level === 'unknown')) {
    const code: ReasonCode = worst.level === 'file' ? 'conflict-file' : worst.level === 'contract' ? 'conflict-contract' : 'conflict-unknown';
    if (ctx.forceOverlap) {
      return build(ctx, config, running, 'INTEGRATE', 'forced-overlap', `forced by ${ctx.forceOverlap.actor}: ${ctx.forceOverlap.reason}; an integration obligation is required`, {
        affects: affected, conflict: { level: worst.level, confidence: worst.confidence }, obligationKey: obligationKey(c.id, worst.other),
      });
    }
    return defer(code, `${worst.level} overlap with ${worst.other} (confidence ${worst.confidence})`, { affects: affected, conflict: { level: worst.level, confidence: worst.confidence } });
  }
  if (worst && worst.level === 'module') {
    return build(ctx, config, running, 'COORDINATE', 'module-overlap', `shares a module with ${affected.join(', ')}; proceeding with a warning`, { affects: affected, conflict: { level: 'module', confidence: worst.confidence } });
  }
  return build(ctx, config, running, 'RUN', 'ok', 'all gates passed', { conflict: { level: 'none', confidence: 1 } });
}

export interface RoundResult { decisions: SchedulingDecision[]; admitted: string[] }

/**
 * One scheduling round over candidates in dispatch order. Earlier candidates are admitted first and
 * count as running for later ones, so a hard-blocked P0 never consumes capacity a Ready P2 could
 * use, and two disjoint Ready tasks both run. Candidates admitted together are reported as BATCH.
 */
export function scheduleRound(contexts: SchedulingContext[], running: RunningWork[], config = DEFAULT_SCHEDULING_CONFIG): RoundResult {
  const live = [...running];
  const decisions: SchedulingDecision[] = [];
  const admitted: string[] = [];
  for (const ctx of contexts) {
    const d = decideOne(ctx, live, config);
    decisions.push(d);
    if (d.kind === 'RUN' || d.kind === 'COORDINATE' || d.kind === 'INTEGRATE') {
      admitted.push(d.id);
      live.push({ id: d.id, repository: ctx.candidate.record.repository, ...(ctx.manifest ? { manifest: ctx.manifest } : {}) });
    }
  }
  if (admitted.length > 1) {
    for (const d of decisions) if (d.kind === 'RUN') { d.kind = 'BATCH'; d.batchWith = admitted.filter((id) => id !== d.id); }
  }
  return { decisions, admitted };
}
