import { dependencyNodeId, type DecisionRecord } from '@open-mercato/cezar-contract';
import { DependencyGraphService } from './service.ts';
import { discoverDecisionCandidates } from './discovery.ts';

/** Persist deterministic, review-only decision proposals from a bounded local scan. */
export async function scanAndProposeDecisions(service: DependencyGraphService, now = new Date().toISOString()) {
  const repository = await service.repositoryKey();
  const snapshot = service.read(repository);
  if (snapshot.source.status !== 'fresh') return { revision: snapshot.revision, proposed: 0, skipped: 'graph is not fresh' };
  const scan = discoverDecisionCandidates(snapshot, { limit: 50, scanLimit: 2_000 });
  let revision = snapshot.revision;
  let proposed = 0;
  for (const candidate of scan.candidates) {
    const current = service.read(repository);
    if (current.source.status !== 'fresh') break;
    const id = dependencyNodeId('decision', repository, `discovery-${candidate.id}`);
    if (current.decisions.some((decision) => decision.id === id)) continue;
    const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
    // Do not publish a proposal based on issue text that changed while the scan was running.
    if (candidate.evidence.some((item) => currentNodes.get(item.nodeId)?.revision !== snapshot.nodes.find((node) => node.id === item.nodeId)?.revision)) continue;
    const decision: DecisionRecord = {
      id,
      repository,
      question: candidate.question.endsWith('?') ? candidate.question : `How should the shared question be resolved: ${candidate.question}`,
      options: ['Choose one shared contract or interface', 'Keep the work independent and document the boundary'],
      rationale: `Deterministic issue-text cluster found ${candidate.affectedNodeIds.length} blocked or waiting issues with a shared phrase. Confidence ${candidate.confidence.toFixed(2)}. This is a review proposal only; it does not create a blocking edge.`,
      evidence: candidate.evidence.slice(0, 100).map((item) => {
        const sourceNode = currentNodes.get(item.nodeId);
        return { url: item.url, label: 'Issue text evidence', excerpt: item.excerpt, nodeId: item.nodeId, ...(sourceNode && 'number' in sourceNode ? { revision: sourceNode.revision } : {}) };
      }),
      reversible: true,
      requiredAuthorization: 'agent-proposal',
      state: 'proposed',
      affectedNodeIds: candidate.affectedNodeIds.slice(0, 10_000),
      createdBy: 'dependency-discovery-scanner',
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    try {
      revision = await service.writeDecision(decision, current.revision, 'dependency-discovery-scanner');
      proposed += 1;
    } catch (error) {
      if (/revision conflict/.test(error instanceof Error ? error.message : String(error))) continue;
      throw error;
    }
  }
  return { revision, proposed, scannedIssues: scan.scannedIssues, truncated: scan.truncated };
}
