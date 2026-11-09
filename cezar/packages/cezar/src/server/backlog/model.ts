import { isValidRank } from './rank.ts';

/** Human-owned base importance. `unset` is explicit: it is never silently defaulted to a level. */
export const BASE_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4', 'unset'] as const;
export type BasePriority = (typeof BASE_PRIORITIES)[number];

/** Mutable workflow lane. Distinct from priority, rank, dependency readiness and dispatch score. */
export const BACKLOG_LANES = ['Inbox', 'Backlog', 'Refinement', 'Ready', 'Active', 'Review', 'Done'] as const;
export type BacklogLane = (typeof BACKLOG_LANES)[number];

export type FieldSource = 'human' | 'inferred' | 'migrated';

export const EDITABLE_FIELDS = ['basePriority', 'backlogRank', 'lane', 'scope', 'owner', 'effort', 'expedite', 'hold', 'dueDate'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface BacklogFields {
  basePriority: BasePriority;
  /** Lexical sortable rank within the project; null = explicitly unranked. */
  backlogRank: string | null;
  lane: BacklogLane;
  scope: string | null;
  owner: string | null;
  /** Estimated effort in whole points; null = unestimated. */
  effort: number | null;
  expedite: boolean;
  hold: boolean;
  /** ISO date (YYYY-MM-DD) or null. */
  dueDate: string | null;
}

export interface FieldProvenance {
  source: FieldSource;
  actor: string;
  at: string;
  reason?: string;
}

export interface BacklogRecord extends BacklogFields {
  /** Case-insensitive `owner/name`; together with issueNumber forms the cross-repo identity. */
  repository: string;
  issueNumber: number;
  /** Policy constraints that gate dispatch independently of lane (e.g. `needs-human-approval`). */
  policyConstraints: string[];
  issueState: 'open' | 'closed';
  archived: boolean;
  provenance: Partial<Record<EditableField, FieldProvenance>>;
  /** Monotonic per-record revision; every accepted write increments it exactly once. */
  revision: number;
  updatedAt: string;
}

export const DEFAULT_FIELDS: BacklogFields = {
  basePriority: 'unset', backlogRank: null, lane: 'Inbox', scope: null, owner: null,
  effort: null, expedite: false, hold: false, dueDate: null,
};

export function recordKey(repository: string, issueNumber: number): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error(`invalid repository "${repository}" (expected owner/name)`);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error(`invalid issue number ${issueNumber}`);
  return `${repository.toLowerCase()}#${issueNumber}`;
}

/** Allowed lane transitions. Any lane may fall back to Backlog/Refinement; Done only reopens to Backlog. */
const TRANSITIONS: Record<BacklogLane, readonly BacklogLane[]> = {
  Inbox: ['Backlog', 'Refinement', 'Done'],
  Backlog: ['Inbox', 'Refinement', 'Ready', 'Done'],
  Refinement: ['Backlog', 'Ready', 'Done'],
  Ready: ['Backlog', 'Refinement', 'Active', 'Done'],
  Active: ['Ready', 'Backlog', 'Refinement', 'Review', 'Done'],
  Review: ['Active', 'Ready', 'Backlog', 'Done'],
  Done: ['Backlog'],
};

export function isAllowedTransition(from: BacklogLane, to: BacklogLane): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export interface ReadyPolicy {
  /** Ready requires an explicit (non-`unset`) base priority. */
  requirePriority: boolean;
  requireScope: boolean;
}
export const DEFAULT_READY_POLICY: ReadyPolicy = { requirePriority: true, requireScope: false };

/** Reasons the record cannot enter Ready; empty = may enter. */
export function readyEntryBlockers(record: Pick<BacklogRecord, 'basePriority' | 'scope' | 'hold' | 'issueState' | 'archived' | 'policyConstraints'>, policy: ReadyPolicy = DEFAULT_READY_POLICY): string[] {
  const out: string[] = [];
  if (record.issueState !== 'open') out.push('issue is closed');
  if (record.archived) out.push('issue is archived');
  if (record.hold) out.push('issue is on hold');
  if (policy.requirePriority && record.basePriority === 'unset') out.push('base priority is unset');
  if (policy.requireScope && !record.scope) out.push('scope is not defined');
  if (record.policyConstraints.length > 0) out.push(`policy constraints: ${record.policyConstraints.join(', ')}`);
  return out;
}

export interface WorkflowEligibility { dispatchable: boolean; reasons: string[] }

/**
 * Backlog-level (not dependency, capacity or conflict) eligibility. Base priority never appears
 * here: a P0 in Refinement keeps its importance but is not dispatchable, while a Ready P2 is.
 */
export function workflowEligibility(record: BacklogRecord): WorkflowEligibility {
  const reasons: string[] = [];
  if (record.lane !== 'Ready') reasons.push(`lane is ${record.lane}, not Ready`);
  if (record.hold) reasons.push('issue is on hold');
  if (record.issueState !== 'open') reasons.push('issue is closed');
  if (record.archived) reasons.push('issue is archived');
  if (record.policyConstraints.length > 0) reasons.push(`policy constraints: ${record.policyConstraints.join(', ')}`);
  return { dispatchable: reasons.length === 0, reasons };
}

const PRIORITY_ORDER: Record<BasePriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, unset: 5 };

/** Deterministic display/tie-break order: expedite, priority, rank, then stable identity. */
export function compareBacklog(a: BacklogRecord, b: BacklogRecord): number {
  if (a.expedite !== b.expedite) return a.expedite ? -1 : 1;
  const p = PRIORITY_ORDER[a.basePriority] - PRIORITY_ORDER[b.basePriority];
  if (p !== 0) return p;
  if (a.backlogRank !== b.backlogRank) {
    if (a.backlogRank === null) return 1;
    if (b.backlogRank === null) return -1;
    return a.backlogRank < b.backlogRank ? -1 : 1;
  }
  const r = a.repository.toLowerCase().localeCompare(b.repository.toLowerCase());
  return r !== 0 ? r : a.issueNumber - b.issueNumber;
}

export function validateFields(fields: Partial<BacklogFields>): string[] {
  const errors: string[] = [];
  if (fields.basePriority !== undefined && !BASE_PRIORITIES.includes(fields.basePriority)) errors.push(`invalid basePriority ${String(fields.basePriority)}`);
  if (fields.lane !== undefined && !BACKLOG_LANES.includes(fields.lane)) errors.push(`invalid lane ${String(fields.lane)}`);
  if (fields.backlogRank != null && !isValidRank(fields.backlogRank)) errors.push(`invalid backlogRank ${fields.backlogRank}`);
  if (fields.effort != null && (!Number.isInteger(fields.effort) || fields.effort < 0)) errors.push('effort must be a non-negative integer');
  if (fields.dueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(fields.dueDate)) errors.push('dueDate must be YYYY-MM-DD');
  return errors;
}
