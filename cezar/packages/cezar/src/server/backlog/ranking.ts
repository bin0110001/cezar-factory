import { workflowEligibility, type BacklogRecord, type BasePriority } from './model.ts';
import { compareRank } from './rank.ts';

/**
 * Deterministic, explainable dispatch scoring (#194). No LLM or hidden input: the same records,
 * inputs, config and `now` always give the same ordering. Hard gates (lane, hold, blockers,
 * approval) are NOT folded into the score; they are returned as separate reasons so a blocked
 * P0 keeps its importance while still being non-dispatchable.
 */
export const RANKING_CONFIG_VERSION = 1;

export interface RankingConfig {
  version: number;
  tierWeight: Record<BasePriority, number>;
  /** Max bonus for the top-ranked issue of a tier; decays linearly down the tier. */
  rankBonus: number;
  expediteBonus: number;
  agingPerDay: number;
  /** Must be smaller than the gap between tiers so aging prevents starvation without leapfrogging priority. */
  agingCap: number;
  unlockPerIssue: number;
  criticalPathPerStep: number;
  unlockCap: number;
  /** Small preference for cheaper work when effort is known. */
  effortBonusMax: number;
  dueSoonBonus: number;
  dueSoonDays: number;
}

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  version: RANKING_CONFIG_VERSION,
  tierWeight: { P0: 1000, P1: 800, P2: 600, P3: 400, P4: 200, unset: 100 },
  rankBonus: 50, expediteBonus: 500, agingPerDay: 5, agingCap: 150,
  unlockPerIssue: 15, criticalPathPerStep: 10, unlockCap: 80, effortBonusMax: 20, dueSoonBonus: 40, dueSoonDays: 7,
};

export interface RankingInput {
  record: BacklogRecord;
  /** ISO time the issue entered the backlog (for aging). */
  createdAt: string;
  /** #150 inputs; undefined = not available, reported as missing, not zero. */
  unlocks?: number;
  criticalPathSteps?: number;
  /** Expedite expires; a lapsed expedite stops counting. */
  expediteUntil?: string | null;
  /** Hard gates from other owners, e.g. dependency (#159) or approval. Each string is a reason. */
  externalGates?: string[];
  /** Human snooze/defer: not dispatchable until this time. */
  snoozeUntil?: string | null;
}

export interface ScoreFactor { name: string; points: number; detail: string }
export interface RankedCandidate {
  id: string;
  record: BacklogRecord;
  eligible: boolean;
  /** Why it cannot be dispatched (empty when eligible). Never encoded as a low score. */
  gates: string[];
  score: number;
  factors: ScoreFactor[];
  /** Inputs that were unavailable, so consumers can tell "zero" from "unknown". */
  missingInputs: string[];
  configVersion: number;
}

const DAY = 86_400_000;

export function candidateId(record: Pick<BacklogRecord, 'repository' | 'issueNumber'>): string { return `${record.repository}#${record.issueNumber}`; }

export function scoreCandidate(input: RankingInput, now: Date, tierRankFraction: number, config = DEFAULT_RANKING_CONFIG): RankedCandidate {
  const { record } = input;
  const factors: ScoreFactor[] = [];
  const missing: string[] = [];
  const add = (name: string, points: number, detail: string) => factors.push({ name, points: Math.round(points * 1000) / 1000, detail });

  add('base-priority', config.tierWeight[record.basePriority], `human priority ${record.basePriority}`);
  if (record.backlogRank === null) add('rank', 0, 'unranked'); else add('rank', config.rankBonus * (1 - tierRankFraction), 'position within priority tier');
  const expediteLive = record.expedite && (!input.expediteUntil || new Date(input.expediteUntil).getTime() > now.getTime());
  if (record.expedite) add('expedite', expediteLive ? config.expediteBonus : 0, expediteLive ? 'human expedite' : 'expedite expired');
  const ageDays = Math.max(0, (now.getTime() - new Date(input.createdAt).getTime()) / DAY);
  add('aging', Math.min(config.agingCap, ageDays * config.agingPerDay), `${ageDays.toFixed(1)} days waiting (cap ${config.agingCap})`);
  if (input.unlocks === undefined && input.criticalPathSteps === undefined) missing.push('dependency-unlock');
  else add('unlock', Math.min(config.unlockCap, (input.unlocks ?? 0) * config.unlockPerIssue + (input.criticalPathSteps ?? 0) * config.criticalPathPerStep), `unlocks ${input.unlocks ?? '?'}, critical path ${input.criticalPathSteps ?? '?'}`);
  if (record.effort === null) missing.push('effort');
  else add('effort', Math.max(0, config.effortBonusMax - record.effort * 2), `${record.effort} points`);
  if (record.dueDate) {
    const daysLeft = (new Date(`${record.dueDate}T23:59:59Z`).getTime() - now.getTime()) / DAY;
    if (daysLeft <= config.dueSoonDays) add('due-date', config.dueSoonBonus, `due in ${Math.max(0, Math.ceil(daysLeft))} days`);
  }

  const gates = [...workflowEligibility(record).reasons, ...(input.externalGates ?? [])];
  if (input.snoozeUntil && new Date(input.snoozeUntil).getTime() > now.getTime()) gates.push(`snoozed until ${input.snoozeUntil}`);
  const score = Math.round(factors.reduce((s, f) => s + f.points, 0) * 1000) / 1000;
  return { id: candidateId(record), record, eligible: gates.length === 0, gates, score, factors, missingInputs: missing, configVersion: config.version };
}

/**
 * Rank all candidates. Eligible ones come first by score, ties broken by rank, then stable identity;
 * ineligible ones follow in the same order with their gate reasons.
 */
export function rankCandidates(inputs: RankingInput[], now: Date, config = DEFAULT_RANKING_CONFIG): RankedCandidate[] {
  const tiers = new Map<BasePriority, RankingInput[]>();
  for (const i of inputs) tiers.set(i.record.basePriority, [...(tiers.get(i.record.basePriority) ?? []), i]);
  const fraction = new Map<string, number>();
  for (const members of tiers.values()) {
    const ranked = members.filter((m) => m.record.backlogRank !== null)
      .sort((a, b) => compareRank(a.record.backlogRank, b.record.backlogRank) || a.record.issueNumber - b.record.issueNumber);
    ranked.forEach((m, idx) => fraction.set(candidateId(m.record), ranked.length <= 1 ? 0 : idx / (ranked.length - 1)));
  }
  return inputs.map((i) => scoreCandidate(i, now, fraction.get(candidateId(i.record)) ?? 1, config)).sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    const r = compareRank(a.record.backlogRank, b.record.backlogRank);
    if (r !== 0) return r;
    const repo = a.record.repository.localeCompare(b.record.repository);
    return repo !== 0 ? repo : a.record.issueNumber - b.record.issueNumber;
  });
}

export interface Recommendation {
  next: RankedCandidate | null;
  /** Top eligible candidates with their full breakdown. */
  top: RankedCandidate[];
  /** Items that need a human before they can ever run (unprioritised or stuck in intake). */
  needsHuman: { id: string; reason: string }[];
  /** Hash-free replay token: identical inputs/config/time bucket produce the identical value. */
  basis: { configVersion: number; candidates: number; at: string };
}

export function recommend(ranked: RankedCandidate[], now: Date, limit = 5): Recommendation {
  const eligible = ranked.filter((r) => r.eligible);
  const needsHuman = ranked.filter((r) => r.record.issueState === 'open' && !r.record.archived && (r.record.basePriority === 'unset'
    && (r.record.lane === 'Inbox' || r.record.lane === 'Refinement' || r.record.lane === 'Backlog')))
    .map((r) => ({ id: r.id, reason: 'base priority is unset; a human must triage it' }));
  return { next: eligible[0] ?? null, top: eligible.slice(0, limit), needsHuman, basis: { configVersion: ranked[0]?.configVersion ?? RANKING_CONFIG_VERSION, candidates: ranked.length, at: now.toISOString() } };
}
