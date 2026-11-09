import type { SchedulingDecision } from './scheduling.ts';
import { BACKLOG_LANES, type BacklogLane, type BacklogRecord } from './model.ts';
import type { AuditEntry } from './store.ts';
import type { Obligation } from './integration-obligations.ts';
import type { RankedCandidate } from './ranking.ts';

/**
 * Read model for the backlog / conflict UI (#201) and its HTTP surface. Pure: it only reshapes
 * data other modules already own (records, ranking, decisions, obligations, audit), so the UI
 * shows the scheduler's own reasons instead of re-deriving them.
 */
export interface BacklogCard {
  id: string;
  title?: string;
  lane: BacklogLane;
  basePriority: BacklogRecord['basePriority'];
  rank: string | null;
  score: number | null;
  /** Dispatch explanation: scheduler decision reason or the ranking gates. */
  status: { kind: 'dispatchable' | 'deferred' | 'not-dispatchable' | 'running'; reasonCode: string; detail: string };
  topFactors: Array<{ name: string; points: number }>;
  badges: Array<'expedite' | 'hold' | 'unranked' | 'priority-unset' | 'conflict' | 'coordinate' | 'integrate'>;
  conflictsWith: string[];
}

export interface ConflictEdge { from: string; to: string; level: 'file' | 'contract' | 'unknown' | 'module'; source: 'decision' | 'obligation' }

export interface BacklogView {
  lanes: Array<{ lane: BacklogLane; cards: BacklogCard[] }>;
  edges: ConflictEdge[];
  /** Open integration obligations = projected merge debt. */
  mergeDebt: { open: number; needsAgent: number; items: Array<{ key: string; state: Obligation['state']; issues: string[]; githubIssue: number | null }> };
  /** Human overrides (priority/rank/lane/expedite/hold edits) newest first. */
  overrideAudit: Array<{ id: string; at: string; actor: string; reason: string | null; changed: string[] }>;
  views: { blocked: string[]; deferred: string[] };
  generatedFrom: { scoreConfigVersion: number | null; decisions: number; obligations: number };
}

export function buildBacklogView(input: {
  ranked: RankedCandidate[];
  decisions?: SchedulingDecision[];
  obligations?: Obligation[];
  audits?: Array<{ id: string; entries: AuditEntry[] }>;
  runningIds?: string[];
}): BacklogView {
  const decisions = new Map((input.decisions ?? []).map((d) => [d.id, d]));
  const running = new Set(input.runningIds ?? []);
  const edges: ConflictEdge[] = [];
  const cards: BacklogCard[] = input.ranked.map((r) => {
    const d = decisions.get(r.id);
    const badges: BacklogCard['badges'] = [];
    if (r.record.expedite) badges.push('expedite');
    if (r.record.hold) badges.push('hold');
    if (r.record.backlogRank === null) badges.push('unranked');
    if (r.record.basePriority === 'unset') badges.push('priority-unset');
    let status: BacklogCard['status'];
    if (running.has(r.id)) status = { kind: 'running', reasonCode: 'running', detail: 'work is in progress' };
    else if (d) {
      const ok = d.kind === 'RUN' || d.kind === 'BATCH' || d.kind === 'COORDINATE' || d.kind === 'INTEGRATE';
      status = { kind: ok ? 'dispatchable' : (r.eligible ? 'deferred' : 'not-dispatchable'), reasonCode: d.reason, detail: d.detail };
      if (d.kind === 'COORDINATE') badges.push('coordinate');
      if (d.kind === 'INTEGRATE') badges.push('integrate');
      if (d.conflict && (d.conflict.level === 'file' || d.conflict.level === 'contract' || d.conflict.level === 'unknown' || d.conflict.level === 'module')) {
        if (d.kind === 'DEFER') badges.push('conflict');
        for (const other of d.affects) edges.push({ from: r.id, to: other, level: d.conflict.level, source: 'decision' });
      }
    } else status = r.eligible
      ? { kind: 'dispatchable', reasonCode: 'ok', detail: 'passes backlog gates; not yet evaluated by the scheduler' }
      : { kind: 'not-dispatchable', reasonCode: 'gated', detail: r.gates.join('; ') };
    return {
      id: r.id, lane: r.record.lane, basePriority: r.record.basePriority, rank: r.record.backlogRank, score: r.score, status,
      topFactors: [...r.factors].sort((a, b) => b.points - a.points).slice(0, 3).map((f) => ({ name: f.name, points: f.points })),
      badges, conflictsWith: d?.affects ?? [],
    };
  });
  const open = (input.obligations ?? []).filter((o) => o.state !== 'resolved' && o.state !== 'cancelled');
  for (const o of open) edges.push({ from: o.issues[0], to: o.issues[1], level: 'file', source: 'obligation' });
  const overrideAudit = (input.audits ?? []).flatMap((a) => a.entries
    .filter((e) => e.source === 'human')
    .map((e) => ({ id: a.id, at: e.createdAt, actor: e.actor, reason: e.reason, changed: Object.keys(e.after) })))
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  const dedupe = new Map<string, ConflictEdge>();
  for (const e of edges) dedupe.set([e.from, e.to].sort().join('|') + e.source, e);
  return {
    lanes: BACKLOG_LANES.map((lane) => ({ lane, cards: cards.filter((c) => c.lane === lane) })),
    edges: [...dedupe.values()],
    mergeDebt: {
      open: open.length, needsAgent: open.filter((o) => o.state === 'needs-agent').length,
      items: open.map((o) => ({ key: o.key, state: o.state, issues: o.issues, githubIssue: o.githubIssue })),
    },
    overrideAudit,
    views: {
      blocked: cards.filter((c) => ['blocked-dependency', 'unknown-dependency'].includes(c.status.reasonCode)).map((c) => c.id),
      deferred: cards.filter((c) => c.status.kind === 'deferred').map((c) => c.id),
    },
    generatedFrom: { scoreConfigVersion: input.ranked[0]?.configVersion ?? null, decisions: decisions.size, obligations: open.length },
  };
}
