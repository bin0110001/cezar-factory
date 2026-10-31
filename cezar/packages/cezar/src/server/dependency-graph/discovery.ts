import { createHash } from 'node:crypto';
import { dependencyNodeId, isVerifiedBlockingEdge, type DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { readiness } from './algorithms.ts';

export interface DecisionCandidate {
  id: string;
  signature: string;
  question: string;
  affectedNodeIds: string[];
  sharedBlockerIds: string[];
  evidence: Array<{ nodeId: string; url: string; excerpt: string }>;
  confidence: number;
}

const STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'and', 'are', 'can', 'could', 'does', 'for', 'from', 'have', 'into', 'it', 'its', 'our', 'should', 'that', 'the', 'their', 'then', 'there', 'this', 'those', 'using', 'use', 'used', 'what', 'when', 'where', 'which', 'with', 'would', 'you', 'your']);

function meaningfulTokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g)?.filter((token) => !STOP_WORDS.has(token)) ?? [])].sort();
}

function candidatePhrases(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  return prose.split(/(?<=[.!?])\s+|\r?\n+/)
    .map((sentence) => sentence.trim().replace(/^[-*#>\s]+/, ''))
    .filter((sentence) => sentence.length >= 18 && sentence.length <= 400 && /\?|\b(decision|decide|choose|whether|should|contract|interface|protocol)\b/i.test(sentence))
    .slice(0, 8);
}

/** Deterministic evidence clustering only. It never emits a BLOCKS edge or writes a decision. */
export function discoverDecisionCandidates(snapshot: DependencyGraphSnapshot, { limit = 50, scanLimit = 2_000 }: { limit?: number; scanLimit?: number } = {}) {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const boundedScan = Math.max(1, Math.min(2_000, Math.floor(scanLimit)));
  const taskNodes = snapshot.nodes.filter((node) => node.kind === 'issue' || node.kind === 'epic').slice(0, boundedScan);
  const taskIds = new Set(taskNodes.map((node) => node.id));
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const status = new Map(readiness(snapshot, [...taskIds]).map((result) => [result.nodeId, result.readiness]));
  const clusters = new Map<string, Array<{ nodeId: string; phrase: string; url: string }>>();
  for (const node of taskNodes) {
    if (node.state !== 'open' || !('bodyText' in node) || !node.bodyText) continue;
    if (status.get(node.id) === 'ready') continue;
    for (const phrase of candidatePhrases(node.bodyText)) {
      const tokens = meaningfulTokens(phrase);
      if (tokens.length < 2) continue;
      const signature = tokens.join(' ');
      const entries = clusters.get(signature) ?? [];
      if (!entries.some((entry) => entry.nodeId === node.id)) entries.push({ nodeId: node.id, phrase, url: node.url });
      clusters.set(signature, entries);
    }
  }
  const existingQuestions = new Set(snapshot.decisions.map((decision) => meaningfulTokens(decision.question).join(' ')));
  const existingIds = new Set(snapshot.decisions.map((decision) => decision.id));
  const candidates: DecisionCandidate[] = [];
  const suppressedAffected = new Set<string>();
  for (const [signature, entries] of clusters) {
    const issueIds = [...new Set(entries.map((entry) => entry.nodeId))].sort();
    if (issueIds.length < 2) continue;
    const affectedKey = issueIds.join('\0');
    if (existingQuestions.has(signature)) { suppressedAffected.add(affectedKey); continue; }
    const blockerReach = new Map<string, Set<string>>();
    for (const edge of snapshot.edges) if (isVerifiedBlockingEdge(edge) && issueIds.includes(edge.to)) {
      const dependents = blockerReach.get(edge.from) ?? new Set<string>(); dependents.add(edge.to); blockerReach.set(edge.from, dependents);
    }
    const commonBlockers = [...blockerReach].filter(([, dependents]) => dependents.size >= 2).map(([blockerId]) => blockerId);
    const normalized = signature.replace(/\s+/g, ' ');
    const id = createHash('sha256').update(`${snapshot.repository}\0${normalized}`).digest('hex').slice(0, 24);
    if (existingIds.has(dependencyNodeId('decision', snapshot.repository, `discovery-${id}`))) { suppressedAffected.add(affectedKey); continue; }
    const evidence = issueIds.slice(0, 20).flatMap((nodeId) => {
      const node = byId.get(nodeId);
      const entry = entries.find((item) => item.nodeId === nodeId);
      return node && entry ? [{ nodeId, url: entry.url, excerpt: entry.phrase.slice(0, 2_000) }] : [];
    });
    candidates.push({
      id,
      signature: normalized,
      question: entries[0]!.phrase,
      affectedNodeIds: issueIds,
      sharedBlockerIds: commonBlockers.sort(),
      evidence,
      confidence: Math.min(0.95, 0.6 + Math.min(issueIds.length, 7) * 0.05),
    });
  }
  const dependentsByBlocker = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (!isVerifiedBlockingEdge(edge) || !taskIds.has(edge.to) || status.get(edge.to) === 'ready') continue;
    const dependents = dependentsByBlocker.get(edge.from) ?? new Set<string>();
    dependents.add(edge.to);
    dependentsByBlocker.set(edge.from, dependents);
  }
  for (const [blockerId, dependentIds] of dependentsByBlocker) {
    const affectedNodeIds = [...dependentIds].sort();
    if (affectedNodeIds.length < 2) continue;
    const affectedKey = affectedNodeIds.join('\0');
    if (suppressedAffected.has(affectedKey) || candidates.some((candidate) => candidate.affectedNodeIds.join('\0') === affectedKey)) continue;
    const blocker = byId.get(blockerId);
    const id = createHash('sha256').update(`${snapshot.repository}\0shared-blocker\0${blockerId}`).digest('hex').slice(0, 24);
    if (candidates.some((candidate) => candidate.id === id)
      || existingIds.has(dependencyNodeId('decision', snapshot.repository, `discovery-${id}`))) continue;
    const title = blocker?.title ?? blockerId;
    candidates.push({
      id,
      signature: `shared-blocker:${blockerId}`,
      question: `What decision or contract would unblock work depending on ${title}?`,
      affectedNodeIds,
      sharedBlockerIds: [blockerId],
      evidence: affectedNodeIds.slice(0, 20).flatMap((nodeId) => {
        const node = byId.get(nodeId);
        if (!node || !('number' in node)) return [];
        const excerpt = node.bodyText ? node.bodyText.slice(0, 500) : node.title;
        return [{ nodeId, url: node.url, excerpt }];
      }),
      confidence: Math.min(0.9, 0.58 + Math.min(affectedNodeIds.length, 8) * 0.04),
    });
  }
  candidates.sort((a, b) => b.affectedNodeIds.length - a.affectedNodeIds.length || b.sharedBlockerIds.length - a.sharedBlockerIds.length || a.id.localeCompare(b.id));
  return {
    revision: snapshot.revision,
    source: snapshot.source,
    candidates: candidates.slice(0, boundedLimit),
    scannedIssues: taskNodes.length,
    truncated: taskNodes.length < snapshot.nodes.filter((node) => node.kind === 'issue' || node.kind === 'epic').length || candidates.length > boundedLimit,
  };
}
