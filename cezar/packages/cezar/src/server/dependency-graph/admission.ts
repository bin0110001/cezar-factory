import type { DependencyGraphSnapshot, GithubRepositoryKey } from '@open-mercato/cezar-contract';
import { readiness } from './algorithms.ts';

export type DependencyAdmission =
  | { status: 'ready'; repository: GithubRepositoryKey; issueNumber: number; nodeId: string; graphRevision: number; reason: string }
  | { status: 'blocked' | 'unknown' | 'closed'; repository: GithubRepositoryKey; issueNumber: number; nodeId?: string; graphRevision: number; blockers: string[]; reason: string };

/** Fail closed unless a fresh graph proves that the open issue has no unresolved verified blocker. */
export function evaluateDependencyAdmission(snapshot: DependencyGraphSnapshot, repository: GithubRepositoryKey, issueNumber: number): DependencyAdmission {
  const node = snapshot.nodes.find((item) => (item.kind === 'issue' || item.kind === 'epic')
    && item.repository.toLocaleLowerCase() === repository.toLocaleLowerCase() && item.number === issueNumber);
  if (snapshot.source.status !== 'fresh') return {
    status: 'unknown', repository, issueNumber, ...(node ? { nodeId: node.id } : {}), graphRevision: snapshot.revision, blockers: [],
    reason: `Dependency graph is ${snapshot.source.status}; scheduler admission requires fresh verified data.`,
  };
  if (!node) return {
    status: 'unknown', repository, issueNumber, graphRevision: snapshot.revision, blockers: [],
    reason: 'Issue is absent from the complete local dependency graph.',
  };
  if (node.state !== 'open') return {
    status: 'closed', repository, issueNumber, nodeId: node.id, graphRevision: snapshot.revision, blockers: [],
    reason: 'Issue is closed and is not eligible for a new scheduled run.',
  };
  const result = readiness(snapshot, [node.id])[0];
  if (!result || result.readiness === 'unknown') return {
    status: 'unknown', repository, issueNumber, nodeId: node.id, graphRevision: snapshot.revision, blockers: result?.unknownBlockers ?? [],
    reason: 'Issue readiness is unknown in the current dependency graph.',
  };
  if (result.readiness === 'blocked') return {
    status: 'blocked', repository, issueNumber, nodeId: node.id, graphRevision: snapshot.revision, blockers: result.blockers,
    reason: `Issue is blocked by ${result.blockers.join(', ')}.`,
  };
  return { status: 'ready', repository, issueNumber, nodeId: node.id, graphRevision: snapshot.revision, reason: 'Fresh graph confirms the issue is ready.' };
}
