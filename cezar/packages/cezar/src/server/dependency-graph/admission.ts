import type { DependencyGraphSnapshot, GithubRepositoryKey } from '@open-mercato/cezar-contract';
import { readiness } from './algorithms.ts';
import type { DependencyGraphService } from './service.ts';

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

/** A graph younger than this is trusted for a verdict that does not depend on a missing issue. */
export const ADMISSION_GRAPH_MAX_AGE_MS = 5 * 60_000;
/** An issue absent from an otherwise fresh graph may simply be new; resync at most this often. */
export const ADMISSION_ABSENT_ISSUE_MAX_AGE_MS = 30_000;

/**
 * Admission that repairs its own missing evidence. A stale, unsynced, or aging graph — or one
 * that predates the issue — is refreshed from GitHub before the verdict instead of deferring
 * the work until the next background sync. If the refresh fails the original fail-closed
 * `unknown` verdict stands and carries the sync warning, so the deferral explains itself.
 * `refresh: false` is for the pre-dispatch recheck, which must not move the graph revision.
 */
export async function admitWithRefresh(
  service: Pick<DependencyGraphService, 'read' | 'refreshIfNeeded'>,
  repository: GithubRepositoryKey,
  issueNumber: number,
  options: { refresh?: boolean } = {},
): Promise<DependencyAdmission> {
  const refresh = options.refresh ?? true;
  let syncWarning: string | undefined;
  const sync = async (maxAgeMs: number) => {
    try {
      const result = await service.refreshIfNeeded({ maxAgeMs });
      if (result && result.status !== 'fresh') syncWarning = result.warning ?? `GitHub synchronization finished ${result.status}.`;
    } catch (error) {
      syncWarning = error instanceof Error ? error.message : String(error);
    }
  };
  if (refresh) await sync(ADMISSION_GRAPH_MAX_AGE_MS);
  let verdict = evaluateDependencyAdmission(service.read(repository), repository, issueNumber);
  if (refresh && verdict.status === 'unknown' && !verdict.nodeId && service.read(repository).source.status === 'fresh') {
    await sync(ADMISSION_ABSENT_ISSUE_MAX_AGE_MS);
    verdict = evaluateDependencyAdmission(service.read(repository), repository, issueNumber);
  }
  return verdict.status === 'unknown' && syncWarning ? { ...verdict, reason: `${verdict.reason} Refresh failed: ${syncWarning}` } : verdict;
}
