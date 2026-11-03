import { decodeBacklogMetadata } from './github-metadata.ts';
import type { ObligationStore, Obligation } from './integration-obligations.ts';
import { BacklogError, type BacklogStore } from './store.ts';

/**
 * GitHub reconciliation driver (#193/#194): reads each issue, folds remote edits into the local
 * projection (conflicts are surfaced, never overwritten), and writes pending local edits back into
 * the issue-body block with a read-after-write check so a concurrent human edit is detected rather
 * than silently lost. `gh` is injected so tests run against an in-memory GitHub.
 */
export type GhRunner = (args: string[]) => Promise<string>;

export type SyncOutcome =
  | { issue: number; status: 'in-sync' }
  | { issue: number; status: 'pulled'; applied: string[] }
  | { issue: number; status: 'pushed'; fields: string[] }
  | { issue: number; status: 'conflict'; fields: string[] }
  | { issue: number; status: 'lost-update'; detail: string }
  | { issue: number; status: 'offline'; detail: string };

interface RemoteIssue { number: number; body: string; state: 'open' | 'closed'; labels: string[]; pullRequest: boolean }

async function readIssue(gh: GhRunner, repository: string, number: number): Promise<RemoteIssue> {
  const raw = JSON.parse(await gh(['api', `repos/${repository}/issues/${number}`])) as { number: number; body?: string | null; state: string; labels?: Array<{ name: string } | string>; pull_request?: unknown };
  return {
    number: raw.number, body: raw.body ?? '', state: raw.state === 'closed' ? 'closed' : 'open', pullRequest: raw.pull_request !== undefined,
    labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
  };
}

/** Pull, merge and (if needed) push one issue. Network failure leaves the local queue untouched. */
export async function syncIssue(options: { store: BacklogStore; repository: string; issueNumber: number; gh: GhRunner; now?: string }): Promise<SyncOutcome> {
  const { store, repository, issueNumber: number, gh } = options;
  let remote: RemoteIssue;
  try { remote = await readIssue(gh, repository, number); }
  catch (error) { return { issue: number, status: 'offline', detail: error instanceof Error ? error.message.slice(0, 300) : 'GitHub unreachable' }; }
  if (remote.pullRequest) return { issue: number, status: 'in-sync' }; // PRs are not backlog items

  store.ensureFromLabels(repository, number, { labels: remote.labels, issueState: remote.state }, options.now ? { now: options.now } : {});
  store.setIssueState(repository, number, { issueState: remote.state });
  const pulled = store.applyRemote(repository, number, remote.body, options.now ? { now: options.now } : {});
  const conflicts = store.openConflicts(repository, number).map((c) => c.field);

  const push = store.pendingPush(repository, number, options.now);
  if (!push) {
    if (conflicts.length > 0) return { issue: number, status: 'conflict', fields: conflicts };
    return pulled.outcome === 'merged' && pulled.applied.length > 0 ? { issue: number, status: 'pulled', applied: pulled.applied } : { issue: number, status: 'in-sync' };
  }
  try {
    const body = store.renderPush(remote.body, push);
    await gh(['api', '-X', 'PATCH', `repos/${repository}/issues/${number}`, '-f', `body=${body}`]);
    // Read-after-write: our block must be what GitHub now holds, otherwise a concurrent edit won the race.
    const after = await readIssue(gh, repository, number);
    const held = decodeBacklogMetadata(after.body);
    if (!held || held.writeId !== push.metadata.writeId) {
      return { issue: number, status: 'lost-update', detail: 'the issue body changed while writing; it will be re-read and reconciled on the next sync' };
    }
    store.markPushed(repository, number, push);
    return conflicts.length > 0 ? { issue: number, status: 'conflict', fields: conflicts } : { issue: number, status: 'pushed', fields: push.fields };
  } catch (error) {
    if (error instanceof BacklogError) return { issue: number, status: 'lost-update', detail: error.message };
    return { issue: number, status: 'offline', detail: error instanceof Error ? error.message.slice(0, 300) : 'GitHub write failed' };
  }
}

/** Sync many issues; an outage on one never aborts the rest and nothing queued is dropped. */
export async function syncRepository(options: { store: BacklogStore; repository: string; issueNumbers: number[]; gh: GhRunner; now?: string }): Promise<SyncOutcome[]> {
  const out: SyncOutcome[] = [];
  for (const issueNumber of [...options.issueNumbers].sort((a, b) => a - b)) {
    const result = await syncIssue({ ...options, issueNumber });
    out.push(result);
    if (result.status === 'offline') {
      // Fail fast on a systemic outage: report the rest as offline without hammering GitHub.
      for (const rest of options.issueNumbers.filter((n) => n > issueNumber).sort((a, b) => a - b)) out.push({ issue: rest, status: 'offline', detail: result.detail });
      break;
    }
  }
  return out;
}

const marker = (key: string) => `<!-- factory-obligation:${key} -->`;

/**
 * Create (at most once) the linked GitHub issue for an obligation that needs an integration agent.
 * Idempotent across crashes: the body carries a marker we search for before creating, and the number
 * is recorded with `linkGithubIssue`.
 */
export async function materializeObligationIssue(options: { obligations: ObligationStore; key: string; repository: string; gh: GhRunner }): Promise<{ created: boolean; number: number; obligation: Obligation }> {
  const { obligations, key, repository, gh } = options;
  const o = obligations.get(key);
  if (!o) throw new Error(`no obligation ${key}`);
  if (o.githubIssue !== null) return { created: false, number: o.githubIssue, obligation: o };
  const found = JSON.parse(await gh(['issue', 'list', '--repo', repository, '--state', 'all', '--search', `"factory-obligation:${key}" in:body`, '--json', 'number', '--limit', '1'])) as Array<{ number: number }>;
  if (found[0]) return { created: false, number: found[0].number, obligation: obligations.linkGithubIssue(key, found[0].number) };
  const body = [
    `Integration obligation between ${o.issues.join(' and ')} (parent epic #192).`,
    '', 'Two concurrently running issues overlap. Reconcile their changes, resolve conflicts, and verify.', '',
    '## Evidence', ...o.evidence.map((e) => `- ${e.at} **${e.kind}**: ${e.detail}`), '', marker(key),
  ].join('\n');
  const url = (await gh(['issue', 'create', '--repo', repository, '--title', `Integrate ${o.issues.join(' + ')}`, '--body', body, '--label', 'type:maintenance'])).trim();
  const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new Error(`could not parse the created issue number from "${url}"`);
  return { created: true, number, obligation: obligations.linkGithubIssue(key, number) };
}

/** Sync every open issue plus anything already in the projection (so closures are noticed). */
export async function syncOpenIssues(options: { store: BacklogStore; repository: string; gh: GhRunner; limit?: number }): Promise<SyncOutcome[]> {
  const listed = JSON.parse(await options.gh(['issue', 'list', '--repo', options.repository, '--state', 'open', '--json', 'number', '--limit', String(options.limit ?? 200)])) as Array<{ number: number }>;
  const known = options.store.list({ repository: options.repository, includeArchived: true }).map((r) => r.issueNumber);
  const numbers = [...new Set([...listed.map((i) => i.number), ...known])];
  return syncRepository({ store: options.store, repository: options.repository, issueNumbers: numbers, gh: options.gh });
}

/** Apply a merge outcome to the head obligation and, if an integration agent is needed, create its single linked issue. */
export async function reconcileObligationOutcome(options: {
  obligations: ObligationStore; key: string; repository: string; gh: GhRunner; outcome: Parameters<ObligationStore['applyOutcome']>[1];
}): Promise<{ obligation: Obligation; needsIntegrationAgent: boolean; githubIssue: number | null }> {
  const applied = options.obligations.applyOutcome(options.key, options.outcome);
  let githubIssue = applied.obligation.githubIssue;
  if (applied.materializeIssue) githubIssue = (await materializeObligationIssue(options)).number;
  return { obligation: options.obligations.get(options.key)!, needsIntegrationAgent: applied.needsIntegrationAgent, githubIssue };
}
