import {
  isVerifiedBlockingEdge,
  dependencyGraphEdgeSchema,
  dependencyGraphSnapshotSchema,
  validateDependencyGraphSnapshot,
  type DependencyGraphNode,
  type DependencyGraphSnapshot,
  type DependencySimulationInput,
} from '@open-mercato/cezar-contract';

export type Readiness = 'ready' | 'blocked' | 'unknown';
export interface ReadinessResult {
  nodeId: string;
  readiness: Readiness;
  blockers: string[];
  unknownBlockers: string[];
}

function open(node: DependencyGraphNode | undefined): boolean | undefined {
  if (!node) return undefined;
  if (node.kind === 'issue' || node.kind === 'epic' || node.kind === 'milestone') return node.state === 'open';
  if (node.kind === 'external-blocker') return node.state === 'open' ? true : node.state === 'resolved' ? false : undefined;
  if (node.kind === 'decision') return ['proposed', 'approved', 'deferred', 'reopened'].includes(node.state);
  return undefined;
}

function blockingAdjacency(snapshot: DependencyGraphSnapshot): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (!isVerifiedBlockingEdge(edge)) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to); adjacency.set(edge.from, list);
  }
  return adjacency;
}

function reachableIssues(nodeId: string, byId: Map<string, DependencyGraphNode>, adjacency: Map<string, string[]>, limit: number): { nodeIds: string[]; truncated: boolean } {
  const visited = new Set<string>([nodeId]);
  const queue = [nodeId];
  let truncated = false;
  const traversalLimit = Math.max(2, limit + 1);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const next of adjacency.get(current) ?? []) if (!visited.has(next)) {
      if (visited.size >= traversalLimit) { truncated = true; continue; }
      visited.add(next); queue.push(next);
    }
  }
  const nodeIds = [...visited].filter((id) => id !== nodeId && ['issue', 'epic'].includes(byId.get(id)?.kind ?? '')).sort();
  if (nodeIds.length > limit) truncated = true;
  return { nodeIds: nodeIds.slice(0, limit), truncated };
}

/** Only complete, fresh snapshots and verified native blocking relationships can establish readiness. */
export function readiness(snapshot: DependencyGraphSnapshot, nodeIds?: readonly string[]): ReadinessResult[] {
  const allowed = new Set(nodeIds ?? snapshot.nodes.map((node) => node.id));
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const blockers = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (!isVerifiedBlockingEdge(edge)) continue;
    const target = blockers.get(edge.to) ?? new Set<string>();
    target.add(edge.from);
    blockers.set(edge.to, target);
  }
  return [...allowed].sort().map((nodeId) => {
    const active: string[] = [];
    const unknown: string[] = [];
    for (const blockerId of [...(blockers.get(nodeId) ?? [])].sort()) {
      const state = open(byId.get(blockerId));
      if (state === true) active.push(blockerId);
      else if (state === undefined) unknown.push(blockerId);
    }
    const snapshotFresh = snapshot.source.status === 'fresh';
    return {
      nodeId,
      readiness: !snapshotFresh || unknown.length ? 'unknown' : active.length ? 'blocked' : 'ready',
      blockers: active,
      unknownBlockers: unknown,
    };
  });
}

/** Stable Tarjan SCCs over verified blocking edges; sorted output is replayable across runs. */
export function blockingCycles(snapshot: DependencyGraphSnapshot): string[][] {
  const adjacency = new Map<string, string[]>();
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  for (const edge of snapshot.edges) {
    if (!isVerifiedBlockingEdge(edge) || !ids.has(edge.from) || !ids.has(edge.to)) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  for (const list of adjacency.values()) list.sort();
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const rootNodes = [...ids].sort();
  for (const root of rootNodes) {
    if (indices.has(root)) continue;
    indices.set(root, index); low.set(root, index); index += 1;
    stack.push(root); onStack.add(root);
    const frames: Array<{ id: string; parent?: string; nextIndex: number }> = [{ id: root, nextIndex: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      const neighbors = adjacency.get(frame.id) ?? [];
      if (frame.nextIndex < neighbors.length) {
        const next = neighbors[frame.nextIndex++]!;
        if (!indices.has(next)) {
          indices.set(next, index); low.set(next, index); index += 1;
          stack.push(next); onStack.add(next);
          frames.push({ id: next, parent: frame.id, nextIndex: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, indices.get(next)!));
        }
        continue;
      }
      frames.pop();
      if (frame.parent) low.set(frame.parent, Math.min(low.get(frame.parent)!, low.get(frame.id)!));
      if (low.get(frame.id) === indices.get(frame.id)) {
        const component: string[] = [];
        let member: string;
        do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== frame.id);
        if (component.length > 1 || (adjacency.get(frame.id) ?? []).includes(frame.id)) components.push(component.sort());
      }
    }
  }
  return components.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

export interface CycleDiagnostic {
  nodeIds: string[];
  witnessNodeIds: string[];
  witnessEdges: DependencyGraphSnapshot['edges'];
}

/** Deterministic shortest witness per blocking SCC, with source edges for an explainable UI. */
export function diagnoseBlockingCycles(snapshot: DependencyGraphSnapshot): CycleDiagnostic[] {
  const cycles = blockingCycles(snapshot);
  const eligible = snapshot.edges.filter(isVerifiedBlockingEdge);
  const componentOf = new Map<string, number>();
  cycles.forEach((component, index) => component.forEach((id) => componentOf.set(id, index)));
  const componentEdges = new Map<number, DependencyGraphSnapshot['edges']>();
  for (const edge of eligible) {
    const component = componentOf.get(edge.from);
    if (component === undefined || component !== componentOf.get(edge.to)) continue;
    const edges = componentEdges.get(component) ?? []; edges.push(edge); componentEdges.set(component, edges);
  }
  const result: CycleDiagnostic[] = [];
  for (const [componentIndex, nodeIds] of cycles.entries()) {
    const members = new Set(nodeIds);
    const start = nodeIds[0]!;
    const outgoing = new Map<string, DependencyGraphSnapshot['edges']>();
    for (const edge of componentEdges.get(componentIndex) ?? []) if (members.has(edge.from) && members.has(edge.to)) {
      const items = outgoing.get(edge.from) ?? [];
      items.push(edge); outgoing.set(edge.from, items);
    }
    for (const list of outgoing.values()) list.sort((a, b) => a.to.localeCompare(b.to) || a.id.localeCompare(b.id));
    const candidates: DependencyGraphSnapshot['edges'][] = [];
    for (const first of outgoing.get(start) ?? []) {
      if (first.to === start) { candidates.push([first]); continue; }
      const queue: Array<{ node: string; edges: DependencyGraphSnapshot['edges'] }> = [{ node: first.to, edges: [first] }];
      const seen = new Set([start, first.to]);
      let candidate: DependencyGraphSnapshot['edges'] | undefined;
      while (queue.length && !candidate) {
        const current = queue.shift()!;
        for (const edge of outgoing.get(current.node) ?? []) {
          if (edge.to === start) { candidate = [...current.edges, edge]; break; }
          if (!seen.has(edge.to)) { seen.add(edge.to); queue.push({ node: edge.to, edges: [...current.edges, edge] }); }
        }
      }
      if (candidate) candidates.push(candidate);
    }
    candidates.sort((a, b) => a.length - b.length || a.map((edge) => edge.id).join('\0').localeCompare(b.map((edge) => edge.id).join('\0')));
    const best = candidates[0];
    const witnessEdges = best ?? [];
    const witnessNodeIds = witnessEdges.length ? [witnessEdges[0]!.from, ...witnessEdges.map((edge) => edge.to)] : nodeIds;
    result.push({ nodeIds, witnessNodeIds, witnessEdges });
  }
  return result;
}

/** Count bounded downstream impact by distinct reachable issues/epics, excluding unverified edges. */
export function downstreamImpact(snapshot: DependencyGraphSnapshot, nodeId: string, limit = 10_000): { count: number; nodeIds: string[]; truncated: boolean } {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const adjacency = blockingAdjacency(snapshot);
  const { nodeIds, truncated } = reachableIssues(nodeId, byId, adjacency, limit);
  return { count: nodeIds.length, nodeIds, truncated };
}

export function dependencyNeighborhood(snapshot: DependencyGraphSnapshot, rootId: string, options: {
  direction?: 'upstream' | 'downstream' | 'both'; depth?: number; limit?: number;
  kinds?: readonly DependencyGraphSnapshot['edges'][number]['kind'][];
} = {}) {
  const root = snapshot.nodes.find((node) => node.id === rootId);
  if (!root) return null;
  const direction = options.direction ?? 'both';
  const depth = Math.max(1, Math.min(5, Math.floor(options.depth ?? 2)));
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const kinds = options.kinds ? new Set(options.kinds) : undefined;
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (kinds && !kinds.has(edge.kind)) continue;
    if (direction !== 'upstream') { const next = adjacency.get(edge.from) ?? new Set<string>(); next.add(edge.to); adjacency.set(edge.from, next); }
    if (direction !== 'downstream') { const next = adjacency.get(edge.to) ?? new Set<string>(); next.add(edge.from); adjacency.set(edge.to, next); }
  }
  const selected = new Set([rootId]);
  const frontier = [rootId];
  let truncated = false;
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next = new Set<string>();
    for (const id of frontier) for (const candidate of adjacency.get(id) ?? []) {
      if (selected.has(candidate)) continue;
      if (selected.size >= limit) { truncated = true; continue; }
      selected.add(candidate); next.add(candidate);
    }
    frontier.splice(0, frontier.length, ...[...next].sort());
  }
  const edges = snapshot.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to) && (!kinds || kinds.has(edge.kind))).slice(0, limit * 4);
  const allInduced = snapshot.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to) && (!kinds || kinds.has(edge.kind))).length;
  return {
    revision: snapshot.revision,
    source: snapshot.source,
    rootId,
    direction,
    depth,
    nodes: [...selected].map((id) => byId.get(id)).filter((node): node is DependencyGraphNode => Boolean(node)).sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    truncated: truncated || allInduced > edges.length,
  };
}

export interface RankedDecision {
  id: string;
  question: string;
  immediateUnlock: number | null;
  downstreamReach: number;
  weightedPriorityReach: number;
  unknownPriorityReach: number;
  oldestAffectedIssueAgeDays: number | null;
  unknownAgeReach: number;
  blockedDuration: { status: 'unavailable'; reason: string };
  score: number | null;
  scoreFactors: { immediateUnlockWeight: 1_000; priorityReachWeight: 10; downstreamReachWeight: 1 };
}

export function rankDecisions(snapshot: DependencyGraphSnapshot, { limit = 20, bundleLimit = 10 }: { limit?: number; bundleLimit?: number } = {}) {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const blockers = new Map<string, string[]>();
  for (const edge of snapshot.edges) if (isVerifiedBlockingEdge(edge)) {
    const list = blockers.get(edge.to) ?? []; list.push(edge.from); blockers.set(edge.to, list);
  }
  const tasks = snapshot.nodes.filter((node) => (node.kind === 'issue' || node.kind === 'epic') && node.state === 'open');
  const unresolved = snapshot.decisions.filter((decision) => !['resolved', 'rejected', 'superseded'].includes(decision.state));
  const adjacency = blockingAdjacency(snapshot);
  const candidates = unresolved.slice(0, 100).map((decision) => ({
    decision,
    reach: reachableIssues(decision.id, byId, adjacency, 10_000).nodeIds,
  }));
  const priorityWeight = (node: DependencyGraphNode): number | undefined => {
    if (node.kind !== 'issue' && node.kind !== 'epic') return undefined;
    const labels = node.labels.map((label) => label.toLowerCase());
    if (labels.some((label) => /(?:priority|prio)\s*:?\s*(?:p0|critical|urgent)/.test(label) || /^p0$/.test(label))) return 4;
    if (labels.some((label) => /(?:priority|prio)\s*:?\s*(?:p1|high)/.test(label) || /^p1$/.test(label))) return 3;
    if (labels.some((label) => /(?:priority|prio)\s*:?\s*(?:p2|medium)/.test(label) || /^p2$/.test(label))) return 2;
    if (labels.some((label) => /(?:priority|prio)\s*:?\s*(?:p3|low)/.test(label) || /^p3$/.test(label))) return 1;
    return undefined;
  };
  const unlocks = (targetId: string, selected: Set<string>): boolean => {
    const sources = blockers.get(targetId) ?? [];
    if (!sources.length) return false;
    let releasedBySelection = false;
    for (const sourceId of sources) {
      if (selected.has(sourceId) && byId.get(sourceId)?.kind === 'decision' && open(byId.get(sourceId)) !== false) { releasedBySelection = true; continue; }
      if (open(byId.get(sourceId)) !== false) return false;
    }
    return releasedBySelection;
  };
  const describe = (items: typeof candidates): RankedDecision[] => items.map(({ decision, reach }) => {
    const idSet = new Set([decision.id]);
    const immediateUnlock = snapshot.source.status === 'fresh' ? tasks.filter((task) => unlocks(task.id, idSet)).length : null;
    let weightedPriorityReach = 0;
    let unknownPriorityReach = 0;
    let oldestAffectedIssueAgeDays: number | null = null;
    let unknownAgeReach = 0;
    for (const nodeId of reach) {
      const reachedNode = byId.get(nodeId);
      const weight = reachedNode ? priorityWeight(reachedNode) : undefined;
      if (weight === undefined) unknownPriorityReach += 1;
      else weightedPriorityReach += weight;
      if (reachedNode && (reachedNode.kind === 'issue' || reachedNode.kind === 'epic')) {
        if (!reachedNode.createdAt) unknownAgeReach += 1;
        else {
          const age = Math.max(0, Math.floor((Date.parse(snapshot.createdAt) - Date.parse(reachedNode.createdAt)) / 86_400_000));
          oldestAffectedIssueAgeDays = oldestAffectedIssueAgeDays === null ? age : Math.max(oldestAffectedIssueAgeDays, age);
        }
      }
    }
    const score = immediateUnlock === null ? null : immediateUnlock * 1_000 + weightedPriorityReach * 10 + reach.length;
    return {
      id: decision.id, question: decision.question, immediateUnlock, downstreamReach: reach.length,
      weightedPriorityReach, unknownPriorityReach, score,
      oldestAffectedIssueAgeDays, unknownAgeReach,
      blockedDuration: { status: 'unavailable', reason: 'GitHub dependency links do not provide a verified blocked-since timestamp.' },
      scoreFactors: { immediateUnlockWeight: 1_000, priorityReachWeight: 10, downstreamReachWeight: 1 },
    };
  });
  const ranked = describe(candidates).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.downstreamReach - a.downstreamReach || a.id.localeCompare(b.id)).slice(0, boundedLimit);
  const bundleCandidates = candidates.slice(0, Math.min(12, candidates.length));
  const bundles: Array<{ decisionIds: string[]; newlyUnlocked: number; taskIds: string[] }> = [];
  const bundleSearchLimit = 1_000;
  let searchedBundles = 0;
  let bundleSearchTruncated = false;
  const visitBundles = (start: number, selectedIds: string[], targetSize: number) => {
    if (selectedIds.length === targetSize) {
      if (searchedBundles >= bundleSearchLimit) { bundleSearchTruncated = true; return; }
      searchedBundles += 1;
      const decisionIds = [...selectedIds].sort();
      const selected = new Set(decisionIds);
      const taskIds = snapshot.source.status === 'fresh' ? tasks.filter((task) => unlocks(task.id, selected)).map((task) => task.id).sort() : [];
      bundles.push({ decisionIds, newlyUnlocked: taskIds.length, taskIds });
      return;
    }
    for (let index = start; index <= bundleCandidates.length - (targetSize - selectedIds.length); index += 1) {
      if (bundleSearchTruncated) return;
      selectedIds.push(bundleCandidates[index]!.decision.id);
      visitBundles(index + 1, selectedIds, targetSize);
      selectedIds.pop();
    }
  };
  for (let size = 2; size <= Math.min(4, bundleCandidates.length); size += 1) visitBundles(0, [], size);
  bundles.sort((a, b) => b.newlyUnlocked - a.newlyUnlocked || a.decisionIds.length - b.decisionIds.length || a.decisionIds.join('|').localeCompare(b.decisionIds.join('|')));
  return {
    revision: snapshot.revision,
    source: snapshot.source,
    decisions: ranked,
    bundles: bundles.slice(0, Math.max(0, Math.min(20, Math.floor(bundleLimit)))),
    truncated: unresolved.length > candidates.length || candidates.length > boundedLimit || candidates.length > 12 || bundleSearchTruncated,
  };
}

export function dependencyGraphHealth(snapshot: DependencyGraphSnapshot) {
  const tasks = snapshot.nodes.filter((node) => (node.kind === 'issue' || node.kind === 'epic') && node.state === 'open');
  const statuses = readiness(snapshot, tasks.map((node) => node.id));
  const statusById = new Map(statuses.map((item) => [item.nodeId, item.readiness]));
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const counts = { ready: 0, blocked: 0, unknown: 0 };
  for (const item of statuses) counts[item.readiness] += 1;
  const verified = snapshot.edges.filter(isVerifiedBlockingEdge);
  const directBlocked = new Map<string, Set<string>>();
  const obsoleteBlockers: Array<{ edgeId: string; blockerId: string; dependentId: string }> = [];
  for (const edge of verified) {
    const source = nodeById.get(edge.from);
    const dependent = nodeById.get(edge.to);
    if (open(source) === false && open(dependent) === true) obsoleteBlockers.push({ edgeId: edge.id, blockerId: edge.from, dependentId: edge.to });
    if (open(source) === true && open(dependent) === true) {
      const targets = directBlocked.get(edge.from) ?? new Set<string>(); targets.add(edge.to); directBlocked.set(edge.from, targets);
    }
  }
  const oldestOpenIssueAgeDays: number | null = tasks.reduce<number | null>((oldest, node) => {
    if (!('createdAt' in node) || !node.createdAt) return oldest;
    const age = Math.max(0, Math.floor((Date.parse(snapshot.createdAt) - Date.parse(node.createdAt)) / 86_400_000));
    return oldest === null ? age : Math.max(oldest, age);
  }, null);
  const unknownIssueAgeCount = tasks.filter((node) => !('createdAt' in node) || !node.createdAt).length;
  const blockedTasks = tasks.filter((node) => statusById.get(node.id) === 'blocked');
  const oldestBlockedAgeDays: number | null = blockedTasks.reduce<number | null>((oldest, node) => {
    if (!('createdAt' in node) || !node.createdAt) return oldest;
    const age = Math.max(0, Math.floor((Date.parse(snapshot.createdAt) - Date.parse(node.createdAt)) / 86_400_000));
    return oldest === null ? age : Math.max(oldest, age);
  }, null);
  const incoming = new Set(verified.map((edge) => edge.to));
  const degree = new Map<string, number>();
  const incident = new Set<string>();
  for (const edge of snapshot.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    incident.add(edge.from); incident.add(edge.to);
  }
  const orphans = tasks.filter((node) => !incoming.has(node.id) && !incident.has(node.id)).map((node) => node.id).sort();
  const hubs = [...degree.entries()].filter(([, count]) => count > 50).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const cycles = blockingCycles(snapshot);
  return {
    revision: snapshot.revision,
    source: snapshot.source,
    counts: { ...counts, openIssues: tasks.length, verifiedBlockers: verified.length, cycles: cycles.length, orphanWork: orphans.length, oversizedHubs: hubs.length },
    aging: { oldestOpenIssueAgeDays, unknownIssueAgeCount, oldestBlockedIssueAgeDays: oldestBlockedAgeDays,
      unknownBlockedAgeCount: blockedTasks.filter((node) => !('createdAt' in node) || !node.createdAt).length,
      blockedDuration: { status: 'unavailable' as const, reason: 'The source does not contain a verified blocked-since timestamp.' } },
    diagnostics: {
      cycles: cycles.slice(0, 20),
      orphanNodeIds: orphans.slice(0, 20),
      hubs: hubs.slice(0, 20).map(([nodeId, edgeCount]) => ({ nodeId, edgeCount })),
      bottlenecks: [...directBlocked].map(([nodeId, targets]) => ({ nodeId, directBlockedIssues: targets.size }))
        .sort((a, b) => b.directBlockedIssues - a.directBlockedIssues || a.nodeId.localeCompare(b.nodeId)).slice(0, 20),
      obsoleteBlockers: obsoleteBlockers.sort((a, b) => a.edgeId.localeCompare(b.edgeId)).slice(0, 20),
    },
    truncated: cycles.length > 20 || orphans.length > 20 || hubs.length > 20 || directBlocked.size > 20 || obsoleteBlockers.length > 20,
  };
}

export function diffDependencySnapshots(before: DependencyGraphSnapshot, after: DependencyGraphSnapshot, limit = 200) {
  if (before.repository !== after.repository) throw new Error('snapshot diff requires the same repository');
  if (before.revision >= after.revision) throw new Error('snapshot diff revisions must be increasing');
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  const compare = <T extends { id: string }>(left: readonly T[], right: readonly T[]) => {
    const oldItems = new Map(left.map((item) => [item.id, item]));
    const newItems = new Map(right.map((item) => [item.id, item]));
    const added: T[] = []; const removed: T[] = []; const changed: Array<{ before: T; after: T }> = [];
    for (const [id, item] of newItems) {
      const prior = oldItems.get(id);
      if (!prior) added.push(item);
      else if (JSON.stringify(prior) !== JSON.stringify(item)) changed.push({ before: prior, after: item });
    }
    for (const [id, item] of oldItems) if (!newItems.has(id)) removed.push(item);
    return { added, removed, changed, totals: { added: added.length, removed: removed.length, changed: changed.length }, truncated: added.length > bounded || removed.length > bounded || changed.length > bounded };
  };
  const nodeChanges = compare(before.nodes, after.nodes);
  const edgeChanges = compare(before.edges, after.edges);
  const decisionChanges = compare(before.decisions, after.decisions);
  const trim = <T>(change: { added: T[]; removed: T[]; changed: Array<{ before: T; after: T }>; totals: { added: number; removed: number; changed: number }; truncated: boolean }) => ({
    ...change, added: change.added.slice(0, bounded), removed: change.removed.slice(0, bounded), changed: change.changed.slice(0, bounded),
  });
  return {
    repository: before.repository,
    fromRevision: before.revision,
    toRevision: after.revision,
    fromSource: before.source,
    toSource: after.source,
    nodes: trim(nodeChanges),
    edges: trim(edgeChanges),
    decisions: trim(decisionChanges),
    truncated: nodeChanges.truncated || edgeChanges.truncated || decisionChanges.truncated,
  };
}

/** Counterfactual analysis only: proposed edges can never be promoted by simulation. */
export function simulateDependencyGraph(snapshot: DependencyGraphSnapshot, input: Pick<DependencySimulationInput, 'expectedRevision'> & Partial<Omit<DependencySimulationInput, 'expectedRevision'>>) {
  if (snapshot.revision !== input.expectedRevision) throw new Error(`dependency graph revision conflict: expected ${input.expectedRevision}, found ${snapshot.revision}`);
  const removeIds = input.removeEdgeIds ?? [];
  const completeIds = input.completeNodeIds ?? [];
  const resolveIds = input.resolveDecisionIds ?? [];
  const addEdges = input.addEdges ?? [];
  const remove = new Set(removeIds);
  if (remove.size !== removeIds.length) throw new Error('simulation contains duplicate edge removals');
  const complete = new Set(completeIds);
  if (complete.size !== completeIds.length) throw new Error('simulation contains duplicate issue completions');
  const resolve = new Set(resolveIds);
  if (resolve.size !== resolveIds.length) throw new Error('simulation contains duplicate decision outcomes');
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const id of complete) {
    const node = byId.get(id);
    if (!node || (node.kind !== 'issue' && node.kind !== 'epic') || node.state !== 'open') throw new Error(`simulation completion requires an open issue or epic: ${id}`);
  }
  const decisionRecords = new Map(snapshot.decisions.map((decision) => [decision.id, decision]));
  for (const id of resolve) {
    const decision = decisionRecords.get(id);
    if (!decision || ['resolved', 'rejected', 'superseded'].includes(decision.state)) throw new Error(`simulation outcome requires an unresolved decision: ${id}`);
    if (!byId.has(id)) throw new Error(`simulation decision node is missing: ${id}`);
  }
  const existing = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  for (const id of remove) if (!existing.has(id)) throw new Error(`simulation edge not found: ${id}`);
  const additions = addEdges.map((edge) => dependencyGraphEdgeSchema.parse(edge));
  for (const edge of additions) {
    if (existing.has(edge.id) && !remove.has(edge.id)) throw new Error(`simulation edge already exists: ${edge.id}`);
    if (isVerifiedBlockingEdge(edge)) throw new Error('simulation cannot assert a new verified blocking edge');
  }
  const after = dependencyGraphSnapshotSchema.parse({
    ...snapshot,
    edges: [...snapshot.edges.filter((edge) => !remove.has(edge.id)), ...additions],
    nodes: snapshot.nodes.map((node) => complete.has(node.id) && (node.kind === 'issue' || node.kind === 'epic')
      ? { ...node, state: 'closed' as const }
      : resolve.has(node.id) && node.kind === 'decision'
        ? { ...node, state: 'resolved' as const }
        : node),
    decisions: snapshot.decisions.map((decision) => resolve.has(decision.id)
      ? { ...decision, state: 'resolved' as const, resolution: decision.resolution ?? 'Hypothetically resolved in simulation' }
      : decision),
  });
  const errors = validateDependencyGraphSnapshot(after);
  if (errors.length) throw new Error(`simulation graph is invalid: ${errors.slice(0, 5).join('; ')}`);
  const touched = [...new Set([
    ...snapshot.edges.filter((edge) => remove.has(edge.id)).map((edge) => edge.to),
    ...additions.map((edge) => edge.to),
    ...complete,
    ...resolve,
    ...snapshot.edges.filter((edge) => (complete.has(edge.from) || resolve.has(edge.from))).map((edge) => edge.to),
  ])].sort();
  const cyclesBefore = blockingCycles(snapshot);
  const cyclesAfter = blockingCycles(after);
  return {
    revision: snapshot.revision,
    persisted: false as const,
    freshness: snapshot.source.status,
    before: readiness(snapshot, touched),
    after: readiness(after, touched),
    hypotheticalCompletions: [...complete].sort(),
    hypotheticalDecisionOutcomes: [...resolve].sort(),
    criticalPath: { status: 'unavailable' as const, reason: 'Issue duration estimates are not present in the source projection.' },
    cyclesBefore: cyclesBefore.slice(0, 50),
    cyclesAfter: cyclesAfter.slice(0, 50),
    truncatedCycles: cyclesBefore.length > 50 || cyclesAfter.length > 50,
  };
}
