import { isVerifiedBlockingEdge, type DependencyGraphNode, type DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { blockingCycles } from './algorithms.ts';

/**
 * Stall detection: "can every open task eventually move without a human fixing the graph?"
 *
 * Every open issue is classified as one of
 *  - `running`   : an automation or person is on it now, or it is in a flow stage that finishes on its own
 *  - `runnable`  : nothing open blocks it and an enabled automation will pick up its state label
 *  - `blocked`   : waiting on other work that is itself runnable or running (progress is expected)
 *  - `waiting`   : parked on a person, a decision or outside information. This is an acceptable stopping
 *                  point and never alarms on its own
 *  - `stuck`     : will never move as things stand (dependency cycle, blocked by a stuck issue, a
 *                  `factory:blocked` label with no open blocker, or no enabled automation consumes its state)
 *
 * The verdict is `stalled` only when open work exists, nothing is runnable or running, and something is stuck.
 * Pure over its inputs so the same graph and automation set always produce the same answer.
 */
export type StallClass = 'running' | 'runnable' | 'blocked' | 'waiting' | 'stuck';
export type StallReason =
  | 'dependency-cycle'
  | 'blocked-by-stuck'
  | 'stale-blocked-label'
  | 'no-consumer'
  | 'no-state-label'
  | 'waiting-on-human'
  | 'waiting-on-decision'
  | 'waiting-on-external'
  | 'blocked-by-work';

export interface StallItem {
  nodeId: string;
  number: number;
  title: string;
  class: StallClass;
  reason?: StallReason;
  /** The root problem a `blocked-by-stuck` item inherits, so one cycle explains everything beneath it. */
  rootCauseIds: string[];
  /** Open verified blockers, nearest first. */
  blockerIds: string[];
  detail: string;
}

export interface StallVerdictInput {
  snapshot: DependencyGraphSnapshot;
  /**
   * State labels at least one ENABLED automation fires on. Omit to skip the consumer checks
   * (the graph-only rules still apply). A paused automation must not be listed.
   */
  consumedLabels?: ReadonlySet<string>;
}

export type StallVerdictKind = 'idle' | 'healthy' | 'waiting' | 'stalled' | 'unknown';

export interface StallReport {
  revision: number;
  verdict: StallVerdictKind;
  summary: string;
  counts: Record<StallClass, number>;
  items: StallItem[];
  cycles: string[][];
}

const HUMAN_WAIT = new Set(['factory:needs-help', 'factory:human-review']);
/** Stages an in-flight issue sits in while an automation or person works on it. */
const IN_FLIGHT = new Set(['factory:working', 'factory:implemented', 'factory:pr-open', 'factory:review', 'factory:changes-requested']);
const STATE_LABELS = new Set(['factory:new', 'factory:investigate', 'factory:needs-plan', 'factory:ready', ...IN_FLIGHT, ...HUMAN_WAIT, 'factory:blocked', 'factory:done']);
/** Epics and tracking issues are closed by hand; they never run, so they are neither stuck nor runnable. */
const isTracking = (node: DependencyGraphNode) => node.kind === 'epic' || ('labels' in node && node.labels.some((label) => label === 'factory:tracking' || label === 'epic'));

function isOpenTask(node: DependencyGraphNode): node is Extract<DependencyGraphNode, { kind: 'issue' | 'epic' }> {
  return (node.kind === 'issue' || node.kind === 'epic') && node.state === 'open';
}

/** What an open non-task blocker (decision, external) means: still open and waiting, or resolved and gone. */
function nonTaskBlocker(node: DependencyGraphNode | undefined): 'waiting-on-decision' | 'waiting-on-external' | 'missing' | 'clear' {
  if (!node) return 'missing';
  if (node.kind === 'decision') return ['proposed', 'approved', 'deferred', 'reopened'].includes(node.state) ? 'waiting-on-decision' : 'clear';
  if (node.kind === 'external-blocker') return node.state === 'resolved' ? 'clear' : 'waiting-on-external';
  if (node.kind === 'milestone') return node.state === 'open' ? 'waiting-on-external' : 'clear';
  return 'clear';
}

const RANK: Record<StallClass, number> = { running: 0, runnable: 1, blocked: 2, waiting: 3, stuck: 4 };

export function diagnoseStalls({ snapshot, consumedLabels }: StallVerdictInput): StallReport {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const cycles = blockingCycles(snapshot);
  const inCycle = new Set(cycles.flat());

  // Open verified blockers per node, restricted to what can still block (open tasks, open decisions/externals).
  const blockersOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (!isVerifiedBlockingEdge(edge)) continue;
    const blocker = byId.get(edge.from);
    const blocked = byId.get(edge.to);
    if (!blocked || !isOpenTask(blocked)) continue;
    if (blocker && isOpenTask(blocker)) {
      (blockersOf.get(edge.to) ?? blockersOf.set(edge.to, []).get(edge.to)!).push(edge.from);
      (dependentsOf.get(edge.from) ?? dependentsOf.set(edge.from, []).get(edge.from)!).push(edge.to);
    } else if (nonTaskBlocker(blocker) !== 'clear') {
      (blockersOf.get(edge.to) ?? blockersOf.set(edge.to, []).get(edge.to)!).push(edge.from);
    }
  }

  const tasks = snapshot.nodes.filter(isOpenTask).filter((node) => !isTracking(node)).sort((a, b) => a.number - b.number);
  const results = new Map<string, StallItem>();

  const ownClass = (node: (typeof tasks)[number], blockers: string[]): Pick<StallItem, 'class' | 'reason' | 'detail'> => {
    const labels = new Set(node.labels);
    if (inCycle.has(node.id)) return { class: 'stuck', reason: 'dependency-cycle', detail: 'part of a blocking cycle: each issue waits on another in the loop' };
    if (labels.has('factory:blocked') && blockers.length === 0) return { class: 'stuck', reason: 'stale-blocked-label', detail: 'labelled factory:blocked but no open blocker exists; automations skip it until the label is removed' };
    for (const label of HUMAN_WAIT) if (labels.has(label)) return { class: 'waiting', reason: 'waiting-on-human', detail: `waiting on a person (${label})` };
    if (node.labels.some((label) => IN_FLIGHT.has(label))) return { class: 'running', detail: 'in flight' };
    if (consumedLabels) {
      const states = node.labels.filter((label) => STATE_LABELS.has(label) && label !== 'factory:blocked' && label !== 'factory:done');
      if (states.length === 0 && !labels.has('factory:blocked')) return { class: 'stuck', reason: 'no-state-label', detail: 'has no factory state label, so no automation will pick it up' };
      if (states.length > 0 && !states.some((label) => consumedLabels.has(label))) return { class: 'stuck', reason: 'no-consumer', detail: `no enabled automation fires on ${states.join(', ')}` };
    }
    return { class: 'runnable', detail: 'an automation will pick it up' };
  };

  // Kahn order over open-task blocking edges, ignoring cycle members (already stuck on their own), so every
  // blocker is classified before the issues it blocks. Iterative: chains can be thousands of issues deep.
  const taskIds = new Set(tasks.map((node) => node.id));
  const pending = new Map<string, number>();
  for (const node of tasks) {
    const count = (blockersOf.get(node.id) ?? []).filter((id) => taskIds.has(id) && !inCycle.has(id)).length;
    pending.set(node.id, count);
  }
  const queue = tasks.filter((node) => pending.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor]!;
    order.push(id);
    for (const next of dependentsOf.get(id) ?? []) {
      if (!taskIds.has(next) || inCycle.has(next)) continue;
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  // Cycle members never reach zero; classify them first so their dependents can read them.
  const cycleMembers = tasks.filter((node) => inCycle.has(node.id)).map((node) => node.id);
  const processing = [...cycleMembers, ...order.filter((id) => !inCycle.has(id))];

  for (const id of processing) {
    const node = byId.get(id) as (typeof tasks)[number];
    const blockerIds = (blockersOf.get(id) ?? []).slice().sort();
    const own = ownClass(node, blockerIds);
    let result: StallItem = { nodeId: id, number: node.number, title: node.title, class: own.class, ...(own.reason ? { reason: own.reason } : {}), rootCauseIds: own.class === 'stuck' ? [id] : [], blockerIds, detail: own.detail };
    const rootCauses = new Set(result.rootCauseIds);
    let waitingReason: StallReason | undefined;
    let blockedByWork = false;
    for (const blockerId of blockerIds) {
      const blocker = byId.get(blockerId);
      if (blocker && isOpenTask(blocker)) {
        if (isTracking(blocker)) continue; // a tracking epic's own state never gates its children
        const state = results.get(blockerId);
        if (!state) continue;
        if (state.class === 'stuck') for (const cause of state.rootCauseIds) rootCauses.add(cause);
        else if (state.class === 'waiting') waitingReason ??= state.reason ?? 'waiting-on-human';
        else blockedByWork = true;
      } else {
        const kind = nonTaskBlocker(blocker);
        if (kind === 'waiting-on-decision' || kind === 'waiting-on-external') waitingReason ??= kind;
      }
    }
    if (rootCauses.size > 0 && result.class !== 'stuck') {
      result = { ...result, class: 'stuck', reason: 'blocked-by-stuck', rootCauseIds: [...rootCauses].sort(), detail: `blocked by work that can never finish (root cause: ${[...rootCauses].sort().join(', ')})` };
    } else if (result.class === 'stuck') {
      result = { ...result, rootCauseIds: [...rootCauses].sort() };
    } else if (waitingReason && RANK.waiting > RANK[result.class]) {
      result = { ...result, class: 'waiting', reason: waitingReason, detail: waitingReason === 'waiting-on-decision' ? 'waiting on an open decision' : waitingReason === 'waiting-on-external' ? 'waiting on outside information' : 'waiting on blocked work that is waiting on a person' };
    } else if (blockedByWork && result.class === 'runnable') {
      result = { ...result, class: 'blocked', reason: 'blocked-by-work', detail: 'waiting on other work that is progressing' };
    }
    results.set(id, result);
  }

  const items = [...results.values()].sort((a, b) => RANK[b.class] - RANK[a.class] || a.number - b.number);
  const counts: Record<StallClass, number> = { running: 0, runnable: 0, blocked: 0, waiting: 0, stuck: 0 };
  for (const item of items) counts[item.class] += 1;

  let verdict: StallVerdictKind;
  let summary: string;
  if (items.length === 0) { verdict = 'idle'; summary = 'No open work.'; }
  else if (snapshot.source.status !== 'fresh' && counts.stuck === 0) { verdict = 'unknown'; summary = `Dependency data is ${snapshot.source.status}; cannot tell whether work is flowing.`; }
  else if (counts.running + counts.runnable > 0) {
    verdict = 'healthy';
    summary = counts.stuck > 0 ? `${counts.running + counts.runnable} issue(s) can progress, but ${counts.stuck} are stuck and need repair.` : `${counts.running + counts.runnable} issue(s) can progress.`;
  } else if (counts.stuck > 0) { verdict = 'stalled'; summary = `No work can progress: ${counts.stuck} issue(s) are stuck and ${counts.waiting} are waiting.`; }
  else { verdict = 'waiting'; summary = `Nothing is runnable; ${counts.waiting} issue(s) are waiting on a person, decision or outside information.`; }

  return { revision: snapshot.revision, verdict, summary, counts, items, cycles };
}
