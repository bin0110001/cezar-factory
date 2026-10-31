import { describe, expect, it } from 'vitest';
import { isVerifiedBlockingEdge } from '@open-mercato/cezar-contract';
import { mapGithubGraphPage, parseGithubRemote, type GithubRepositoryRef } from './github-source.ts';

const repo: GithubRepositoryRef = {
  host: 'github.com', owner: 'acme', name: 'work', key: 'acme/work', url: 'https://github.com/acme/work',
};
const at = '2026-10-30T12:00:00.000Z';

function linked(number: number, repository = 'acme/work') {
  return { number, title: `Issue ${number}`, state: 'OPEN', updatedAt: at, url: `https://github.com/${repository}/issues/${number}`, repository: { nameWithOwner: repository } };
}

function issue(number: number, extra: Record<string, unknown> = {}) {
  return {
    ...linked(number),
    labels: { totalCount: 0, nodes: [] },
    milestone: null,
    parent: null,
    issueDependenciesSummary: { totalBlockedBy: 0, totalBlocking: 0 },
    blockedBy: { totalCount: 0, nodes: [] },
    blocking: { totalCount: 0, nodes: [] },
    ...extra,
  };
}

describe('GitHub dependency projection', () => {
  it('resolves GitHub.com and enterprise remotes without a network request', () => {
    expect(parseGithubRemote('https://github.com/acme/work.git')).toMatchObject({ host: 'github.com', key: 'acme/work' });
    expect(parseGithubRemote('git@github.example.net:acme/work.git')).toMatchObject({ host: 'github.example.net', key: 'github.example.net/acme/work' });
    expect(parseGithubRemote('https://example.net/not-a-repository/too/many')).toBeNull();
  });

  it('maps native blockers prerequisite-first and keeps hierarchy separate', () => {
    const page = mapGithubGraphPage({
      data: { repository: {
        nameWithOwner: 'acme/work', url: repo.url,
        issues: {
          nodes: [
            issue(1, { bodyText: 'x'.repeat(9_000), labels: { totalCount: 1, nodes: [{ name: 'factory:tracking' }] }, blocking: { totalCount: 1, nodes: [linked(2)] } }),
            issue(2, { blockedBy: { totalCount: 1, nodes: [linked(1)] }, issueDependenciesSummary: { totalBlockedBy: 1, totalBlocking: 0 } }),
            issue(3, { parent: linked(1) }),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } },
    }, repo, at);
    const blocker = page.nodes.find((node) => 'number' in node && node.number === 1)!;
    const dependent = page.nodes.find((node) => 'number' in node && node.number === 2)!;
    const edge = page.edges.find((entry) => entry.kind === 'BLOCKS')!;
    expect(blocker.kind).toBe('epic');
    expect('bodyText' in blocker ? blocker.bodyText?.length : 0).toBe(8_000);
    expect(edge.from).toBe(blocker.id);
    expect(edge.to).toBe(dependent.id);
    expect(isVerifiedBlockingEdge(edge)).toBe(true);
    expect(page.edges.find((entry) => entry.kind === 'PART_OF')).toMatchObject({ kind: 'PART_OF', direction: 'from-to' });
  });

  it('preserves cross-repository identities and reports truncated native dependency data', () => {
    const page = mapGithubGraphPage({
      data: { repository: {
        nameWithOwner: 'acme/work', url: repo.url,
        issues: {
          nodes: [issue(3, {
            blockedBy: { totalCount: 2, nodes: [linked(7, 'other/api')] },
            issueDependenciesSummary: { totalBlockedBy: 2, totalBlocking: 0 },
          })],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      } },
    }, repo, at);
    expect(page.repository).toBe('acme/work');
    expect(page.nodes.some((node) => node.repository === 'other/api')).toBe(true);
    expect(page.edges[0]?.from).toBe('issue:github.com/other/api:7');
    expect(page.dependencyTruncated).toBe(true);
    expect(page.hasNextPage).toBe(true);
  });

  it('uses host-qualified node ids for GitHub Enterprise repositories', () => {
    const enterprise = { ...repo, host: 'github.example.net', key: 'github.example.net/acme/work', url: 'https://github.example.net/acme/work' };
    const page = mapGithubGraphPage({
      data: { repository: {
        nameWithOwner: 'acme/work', url: enterprise.url,
        issues: { nodes: [issue(8)], pageInfo: { hasNextPage: false, endCursor: null } },
      } },
    }, enterprise, at);
    expect(page.nodes[0]?.id).toBe('issue:github.example.net/acme/work:8');
  });
});
