import type { BacklogFields, BacklogLane, BasePriority } from './model.ts';

export interface LabelMigration {
  fields: Partial<Pick<BacklogFields, 'basePriority' | 'lane'>>;
  /** Existing labels that supplied a value; kept on the issue (migration never deletes labels). */
  sourceLabels: string[];
  warnings: string[];
}

const NUMERIC_PRIORITY: BasePriority[] = ['P4', 'P3', 'P2', 'P1', 'P0'];

/** Legacy `priority:<n>` is "higher runs first": 4+ -> P0 ... 0 or negative -> P4. */
export function priorityFromLabel(label: string): BasePriority | null {
  const named = /^(?:priority[:/ ]?)?p([0-4])$/i.exec(label.trim());
  if (named) return `P${named[1]}` as BasePriority;
  const numeric = /^priority:(-?[0-9]+)$/i.exec(label.trim());
  if (!numeric) return null;
  return NUMERIC_PRIORITY[Math.max(0, Math.min(4, Number(numeric[1])))] ?? null;
}

const LANE_BY_STATE: Record<string, BacklogLane> = {
  'factory:new': 'Inbox',
  'factory:investigate': 'Inbox',
  'factory:needs-plan': 'Refinement',
  'factory:ready': 'Ready',
  'factory:working': 'Active',
  'factory:implemented': 'Review',
  'factory:pr-open': 'Review',
  'factory:review': 'Review',
  'factory:human-review': 'Review',
  'factory:changes-requested': 'Active',
  'factory:done': 'Done',
};

const LANE_ORDER: BacklogLane[] = ['Inbox', 'Backlog', 'Refinement', 'Ready', 'Active', 'Review', 'Done'];

/** Derive initial fields from existing labels without discarding any information. */
export function migrateFromLabels(labels: readonly string[], issueState: 'open' | 'closed'): LabelMigration {
  const sourceLabels: string[] = [];
  const warnings: string[] = [];
  const priorities = new Map<BasePriority, string>();
  let lane: BacklogLane | null = null;
  for (const label of labels) {
    const p = priorityFromLabel(label);
    if (p) { priorities.set(p, label); sourceLabels.push(label); }
    const l = LANE_BY_STATE[label];
    if (l) {
      sourceLabels.push(label);
      if (lane === null || LANE_ORDER.indexOf(l) > LANE_ORDER.indexOf(lane)) lane = l;
    }
  }
  const fields: LabelMigration['fields'] = {};
  if (priorities.size > 0) {
    const winner = [...priorities.keys()].sort()[0]!; // the most urgent label wins
    fields.basePriority = winner;
    if (priorities.size > 1) warnings.push(`conflicting priority labels (${[...priorities.values()].join(', ')}); used ${winner}`);
  }
  if (issueState === 'closed') fields.lane = 'Done';
  else if (lane !== null) fields.lane = lane === 'Done' ? 'Backlog' : lane; // open + done label: reopened
  return { fields, sourceLabels, warnings };
}
