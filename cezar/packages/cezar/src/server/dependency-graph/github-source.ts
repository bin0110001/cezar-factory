import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  dependencyNodeId,
  type DependencyGraphEdge,
  type DependencyGraphNode,
  type GithubRepositoryKey,
} from '@open-mercato/cezar-contract';
import { stableDependencyEdgeId } from './ids.ts';

const execFileAsync = promisify(execFile);
export const DEPENDENCY_GRAPH_GITHUB_PAGE_SIZE = 100;
export const DEPENDENCY_GRAPH_MAX_PAGES = 100;
export const DEPENDENCY_GRAPH_INCREMENTAL_OVERLAP_MS = 5 * 60_000;
export const DEPENDENCY_GRAPH_FULL_SYNC_INTERVAL_MS = 24 * 60 * 60_000;

export interface GithubRepositoryRef {
  host: string;
  owner: string;
  name: string;
  key: GithubRepositoryKey;
  url: string;
}

export interface GithubGraphPage {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  repository: GithubRepositoryKey;
  repoUrl: string;
  watermark?: string;
  nextCursor?: string;
  hasNextPage: boolean;
  dependencyTruncated: boolean;
  rootIssueCount: number;
  rootIssueOldestUpdatedAt?: string;
  rootIssueNewestUpdatedAt?: string;
}

export type DependencyGraphGhRunner = (repoRoot: string, args: string[], timeoutMs: number) => Promise<string>;
export type DependencyGraphGitRunner = (repoRoot: string, args: string[], timeoutMs: number) => Promise<string>;

const linkedIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  updatedAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  url: z.url({ protocol: /^https$/ }),
  repository: z.object({ nameWithOwner: z.string().min(3) }).strict(),
}).passthrough();

const issueSchema = linkedIssueSchema.extend({
  labels: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(z.object({ name: z.string() }).strict()) }).strict(),
  bodyText: z.string().max(1_000_000).optional(),
  milestone: z.object({ number: z.number().int().positive(), title: z.string(), url: z.url({ protocol: /^https$/ }).optional() }).strict().nullable(),
  parent: linkedIssueSchema.nullable(),
  issueDependenciesSummary: z.object({ totalBlockedBy: z.number().int().nonnegative(), totalBlocking: z.number().int().nonnegative() }).strict(),
  blockedBy: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(linkedIssueSchema) }).strict(),
  blocking: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(linkedIssueSchema) }).strict(),
});

const graphqlPageSchema = z.object({
  data: z.object({
    repository: z.object({
      nameWithOwner: z.string().min(3),
      url: z.url({ protocol: /^https$/ }),
      issues: z.object({
        nodes: z.array(issueSchema),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).strict(),
      }).strict(),
    }).nullable(),
  }).strict(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
}).passthrough();

const repoViewSchema = z.object({
  nameWithOwner: z.string().min(3),
  url: z.url({ protocol: /^https$/ }),
}).strict();

const ISSUE_PAGE_QUERY = `query DependencyIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner url
    issues(first: 100, after: $after, states: [OPEN, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        ...IssueFields
        bodyText
        labels(first: 100) { totalCount nodes { name } }
        milestone { number title url }
        parent { ...LinkedIssueFields }
        issueDependenciesSummary { totalBlockedBy totalBlocking }
        blockedBy(first: 100) { totalCount nodes { ...LinkedIssueFields } }
        blocking(first: 100) { totalCount nodes { ...LinkedIssueFields } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
fragment IssueFields on Issue {
  number title state createdAt updatedAt url repository { nameWithOwner }
}
fragment LinkedIssueFields on Issue {
  number title state createdAt updatedAt url repository { nameWithOwner }
}`;

function hostFromUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname.toLowerCase();
}

function keyFor(host: string, ownerName: string): GithubRepositoryKey {
  const [owner, name, ...rest] = ownerName.split('/');
  if (!owner || !name || rest.length) throw new Error('GitHub returned an invalid repository name');
  return host === 'github.com' ? `${owner}/${name}` : `${host}/${owner}/${name}`;
}

export function mapGithubGraphPage(raw: unknown, expected: GithubRepositoryRef, now = new Date().toISOString()): GithubGraphPage {
  const parsed = graphqlPageSchema.parse(raw);
  const repository = parsed.data.repository;
  if (!repository) throw new Error('GitHub repository is unavailable or inaccessible');
  const repositoryKey = keyFor(expected.host, repository.nameWithOwner);
  if (repositoryKey !== expected.key) throw new Error('GitHub repository identity changed during dependency sync');

  const nodes = new Map<string, DependencyGraphNode>();
  const edges = new Map<string, DependencyGraphEdge>();
  const issueIds = new Map<string, string>();
  let dependencyTruncated = false;
  let watermark: string | undefined;

  const addIssue = (issue: z.infer<typeof linkedIssueSchema>, labels: string[] = [], bodyText?: string): string => {
    const issueRepository = keyFor(expected.host, issue.repository.nameWithOwner);
    const issueKey = `${issueRepository}#${issue.number}`;
    const proposedKind = labels.some((label) => label.toLowerCase() === 'epic' || label.toLowerCase() === 'factory:tracking') ? 'epic' : 'issue';
    const previousId = issueIds.get(issueKey);
    const previous = previousId ? nodes.get(previousId) : undefined;
    const kind = proposedKind === 'epic' || previous?.kind === 'epic' ? 'epic' : 'issue';
    const id = dependencyNodeId(kind, issueRepository, issue.number);
    const existing = nodes.get(id);
    const existingIssue = existing && 'number' in existing ? existing : undefined;
    const previousIssue = previous && 'number' in previous ? previous : undefined;
    const latest = existingIssue && existingIssue.updatedAt > issue.updatedAt
      ? existingIssue
      : previousIssue && previousIssue.updatedAt > issue.updatedAt ? previousIssue : undefined;
    if (previous && previous.id !== id) nodes.delete(previous.id);
    const mergedLabels = [...new Set([...(existing && 'labels' in existing ? existing.labels : previous && 'labels' in previous ? previous.labels : []), ...labels])];
    issueIds.set(issueKey, id);
    nodes.set(id, {
      kind,
      id,
      repository: issueRepository,
      number: issue.number,
      title: latest?.title ?? issue.title,
      state: latest?.state ?? (issue.state === 'OPEN' ? 'open' : 'closed'),
      ...(mergedLabels.find((label) => label.startsWith('factory:')) ? { status: mergedLabels.find((label) => label.startsWith('factory:')) } : {}),
      labels: mergedLabels,
      ...((latest?.createdAt ?? issue.createdAt) ? { createdAt: latest?.createdAt ?? issue.createdAt } : {}),
      ...((bodyText ?? existingIssue?.bodyText ?? previousIssue?.bodyText) !== undefined ? { bodyText: (bodyText ?? existingIssue?.bodyText ?? previousIssue?.bodyText)!.slice(0, 8_000) } : {}),
      url: latest?.url ?? issue.url,
      revision: latest?.revision ?? issue.updatedAt,
      updatedAt: latest?.updatedAt ?? issue.updatedAt,
    });
    if (watermark === undefined || issue.updatedAt > watermark) watermark = issue.updatedAt;
    return id;
  };

  const addEdge = (from: string, to: string, kind: DependencyGraphEdge['kind'], evidenceUrl: string, sourceRevision: string) => {
    const id = stableDependencyEdgeId(from, to, kind);
    edges.set(id, {
      id,
      kind,
      from,
      to,
      direction: 'from-to',
      provenance: {
        origin: kind === 'BLOCKS' ? 'github-native' : 'system',
        authority: kind === 'BLOCKS' ? 'verified' : 'unverified',
        confidence: 1,
        recordedAt: now,
        sourceRevision,
        sourceUrl: evidenceUrl,
        evidence: [{ url: evidenceUrl, label: kind === 'BLOCKS' ? 'GitHub native issue dependency' : `GitHub ${kind} relationship` }],
      },
      createdAt: now,
      updatedAt: now,
    });
  };

  for (const issue of repository.issues.nodes) {
    const labels = issue.labels.nodes.map((label) => label.name);
    if (issue.labels.totalCount > issue.labels.nodes.length) dependencyTruncated = true;
    const issueId = addIssue(issue, labels, issue.bodyText);
    if (issue.issueDependenciesSummary.totalBlockedBy > issue.blockedBy.nodes.length
      || issue.issueDependenciesSummary.totalBlocking > issue.blocking.nodes.length
      || issue.blockedBy.totalCount > issue.blockedBy.nodes.length
      || issue.blocking.totalCount > issue.blocking.nodes.length) dependencyTruncated = true;
    for (const blocker of issue.blockedBy.nodes) addEdge(addIssue(blocker), issueId, 'BLOCKS', issue.url, issue.updatedAt);
    for (const dependent of issue.blocking.nodes) addEdge(issueId, addIssue(dependent), 'BLOCKS', issue.url, issue.updatedAt);
    if (issue.parent) addEdge(issueId, addIssue(issue.parent), 'PART_OF', issue.url, issue.updatedAt);
    if (issue.milestone) {
      const milestoneId = dependencyNodeId('milestone', repositoryKey, issue.milestone.number);
      nodes.set(milestoneId, {
        kind: 'milestone', id: milestoneId, repository: repositoryKey, key: String(issue.milestone.number),
        title: issue.milestone.title, state: 'open', ...(issue.milestone.url ? { url: issue.milestone.url } : {}),
        revision: issue.updatedAt, updatedAt: issue.updatedAt,
      });
      addEdge(issueId, milestoneId, 'PART_OF', issue.url, issue.updatedAt);
    }
  }

  const rootDates = repository.issues.nodes.map((issue) => issue.updatedAt).sort();
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    repository: repositoryKey,
    repoUrl: repository.url,
    ...(watermark ? { watermark } : {}),
    nextCursor: repository.issues.pageInfo.endCursor ?? undefined,
    hasNextPage: repository.issues.pageInfo.hasNextPage,
    dependencyTruncated,
    rootIssueCount: repository.issues.nodes.length,
    ...(rootDates.length ? { rootIssueOldestUpdatedAt: rootDates[0], rootIssueNewestUpdatedAt: rootDates[rootDates.length - 1] } : {}),
  };
}

async function defaultGhRunner(repoRoot: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

async function defaultGitRunner(repoRoot: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return stdout.trim();
}

export function parseGithubRemote(remote: string): GithubRepositoryRef | null {
  let host = '';
  let path = '';
  const value = remote.trim();
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return null;
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.replace(/^\/+/, '');
  } catch {
    const ssh = /^(?:[^@]+@|ssh:\/\/git@)([^:/]+)[:/](.+)$/.exec(value);
    if (!ssh) return null;
    host = ssh[1]!.toLowerCase();
    path = ssh[2]!;
  }
  path = path.replace(/\.git$/i, '').replace(/\/+$/, '');
  const [owner, name, ...rest] = path.split('/');
  if (!host || !owner || !name || rest.length > 0) return null;
  const key = keyFor(host, `${owner}/${name}`);
  return { host, owner, name, key, url: `https://${host}/${owner}/${name}` };
}

export class GithubDependencySource {
  constructor(
    private readonly repoRoot: string,
    private readonly runner: DependencyGraphGhRunner = defaultGhRunner,
    private readonly gitRunner: DependencyGraphGitRunner = defaultGitRunner,
  ) {}

  async repository(): Promise<GithubRepositoryRef> {
    try {
      const remote = await this.gitRunner(this.repoRoot, ['remote', 'get-url', 'origin'], 5_000);
      const ref = parseGithubRemote(remote);
      if (ref) return ref;
    } catch {
      // Repositories without a readable Git remote can still use the authenticated gh fallback.
    }
    const output = await this.runner(this.repoRoot, ['repo', 'view', '--json', 'nameWithOwner,url'], 15_000);
    const parsed = repoViewSchema.parse(JSON.parse(output));
    const host = hostFromUrl(parsed.url);
    const [owner, name, ...rest] = parsed.nameWithOwner.split('/');
    if (!owner || !name || rest.length) throw new Error('GitHub repository nameWithOwner is malformed');
    return { host, owner, name, key: keyFor(host, parsed.nameWithOwner), url: parsed.url };
  }

  async page(repository: GithubRepositoryRef, after?: string): Promise<GithubGraphPage> {
    const args = ['api', '--hostname', repository.host, 'graphql', '-f', `query=${ISSUE_PAGE_QUERY}`, '-F', `owner=${repository.owner}`, '-F', `name=${repository.name}`];
    if (after) args.push('-F', `after=${after}`);
    const output = await this.runner(this.repoRoot, args, 45_000);
    const parsed = graphqlPageSchema.parse(JSON.parse(output));
    if (parsed.errors?.length) throw new Error(parsed.errors.map((error) => error.message).join('; ').slice(0, 1_000));
    return mapGithubGraphPage(parsed, repository);
  }
}
