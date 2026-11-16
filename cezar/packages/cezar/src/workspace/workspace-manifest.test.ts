import { describe, expect, it } from 'vitest';
import type { ProjectListEntry } from './projects.ts';
import { buildWorkspaceManifest } from './workspace-manifest.ts';

function project(overrides: Partial<ProjectListEntry> & Pick<ProjectListEntry, 'id' | 'root'>): ProjectListEntry {
  return {
    name: overrides.id,
    addedAt: '',
    lastOpenedAt: '',
    source: 'local',
    status: 'ok',
    ...overrides,
  };
}

describe('workspace manifest', () => {
  it('returns sorted, path-free identities with local revisions and unknown visibility', async () => {
    const projects = [
      project({ id: 'zeta', root: 'C:/private/zeta', branch: 'main', forge: 'github', repoUrl: 'https://github.com/acme/zeta' }),
      project({ id: 'alpha', root: 'C:/private/alpha', branch: 'dev', forge: 'github', repoUrl: 'https://github.com/acme/alpha' }),
      project({ id: 'local', root: 'C:/private/local', branch: 'main' }),
    ];
    const manifest = await buildWorkspaceManifest(projects, async (root) => root.endsWith('alpha') ? 'A'.repeat(40) : null);
    expect(manifest.repositories.map((repo) => repo.projectId)).toEqual(['alpha', 'local', 'zeta']);
    expect(manifest.repositories[0]).toMatchObject({
      repository: 'acme/alpha', owner: 'acme', branch: 'dev', sha: 'a'.repeat(40), visibility: 'unknown',
    });
    expect(manifest.repositories[1]).toMatchObject({ repository: null, owner: null, sha: null });
    expect(manifest.repositories[0]?.dependencyEdgeKinds).toContain('BLOCKS');
    expect(JSON.stringify(manifest)).not.toContain('C:/private');
    expect(manifest.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('omits unregistered roots and produces a stable revision', async () => {
    const projects = [
      project({ id: 'registered', root: '/secret/root', status: 'not-git' }),
      project({ id: 'boot-only', root: '/secret/boot', unregistered: true }),
    ];
    const first = await buildWorkspaceManifest(projects);
    const second = await buildWorkspaceManifest(projects);
    expect(first).toEqual(second);
    expect(first.repositories).toEqual([{
      projectId: 'registered', repository: null, owner: null, branch: null, sha: null,
      visibility: 'unknown', dependencyEdgeKinds: first.repositories[0]?.dependencyEdgeKinds,
    }]);
    expect(JSON.stringify(first)).not.toContain('/secret');
  });

  it('rejects a non-canonical or credential-bearing repository URL', async () => {
    const manifest = await buildWorkspaceManifest([
      project({ id: 'bad', root: '/private', repoUrl: 'https://user:token@github.com/acme/repo?x=1' }),
    ]);
    expect(manifest.repositories[0]).toMatchObject({ repository: null, owner: null });
  });
});
