import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  dependencyEdgeKindSchema,
  workspaceManifestResponseSchema,
  type WorkspaceManifestResponse,
  type WorkspaceManifestAmbiguity,
  type WorkspaceManifestEdge,
  type WorkspaceManifestRepository,
} from '@open-mercato/cezar-contract';
import type { ProjectListEntry } from './projects.ts';

const execFile = promisify(execFileCallback);
const dependencyEdgeKinds = [...dependencyEdgeKindSchema.options];

type PackageMetadata = { name: string; dependencies: Record<string, string> };

async function readPackageMetadata(root: string): Promise<PackageMetadata | null> {
  try {
    const value: unknown = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name.trim()) return null;
    const dependencies: Record<string, string> = {};
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const entries = record[section];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [name, range] of Object.entries(entries)) {
        if (typeof range === 'string') dependencies[name] = range;
      }
    }
    return { name: record.name, dependencies };
  } catch {
    return null;
  }
}

function discoverPackageEdges(
  packageMetadata: ReadonlyMap<string, PackageMetadata | null>,
): { edges: WorkspaceManifestEdge[]; ambiguities: WorkspaceManifestAmbiguity[] } {
  const candidates = new Map<string, string[]>();
  for (const [projectId, metadata] of packageMetadata) {
    if (!metadata) continue;
    const matches = candidates.get(metadata.name) ?? [];
    matches.push(projectId);
    candidates.set(metadata.name, matches);
  }

  const edges: WorkspaceManifestEdge[] = [];
  const ambiguities: WorkspaceManifestAmbiguity[] = [];
  for (const [fromProjectId, metadata] of packageMetadata) {
    if (!metadata) continue;
    for (const [dependencyName, versionRange] of Object.entries(metadata.dependencies).sort(([a], [b]) => a.localeCompare(b))) {
      const matches = candidates.get(dependencyName) ?? [];
      if (matches.length > 1) {
        ambiguities.push({ fromProjectId, dependencyName, candidateProjectIds: [...matches].sort() });
      } else if (matches.length === 1 && matches[0] !== fromProjectId) {
        edges.push({
          fromProjectId,
          toProjectId: matches[0]!,
          kind: 'package-dependency',
          provenance: 'code-derived',
          manifest: 'package.json',
          dependencyName,
          versionRange,
        });
      }
    }
  }
  edges.sort((a, b) => a.fromProjectId.localeCompare(b.fromProjectId)
    || a.toProjectId.localeCompare(b.toProjectId) || a.dependencyName.localeCompare(b.dependencyName));
  ambiguities.sort((a, b) => a.fromProjectId.localeCompare(b.fromProjectId)
    || a.dependencyName.localeCompare(b.dependencyName));
  return { edges, ambiguities };
}

/** Parse only the already-sanitized GitHub web URL exposed by the project probe. */
function githubIdentity(repoUrl: string | undefined): { repository: string | null; owner: string | null } {
  if (!repoUrl) return { repository: null, owner: null };
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
      || url.search || url.hash) return { repository: null, owner: null };
    const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(url.pathname);
    if (!match) return { repository: null, owner: null };
    const owner = match[1]!;
    const repo = match[2]!;
    const normalizedOwner = owner.toLowerCase();
    return { repository: `${normalizedOwner}/${repo.replace(/\.git$/i, '').toLowerCase()}`, owner: normalizedOwner };
  } catch {
    return { repository: null, owner: null };
  }
}

async function readHeadSha(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 1024,
    });
    const sha = stdout.trim();
    return /^[a-f0-9]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Build a stable, path-free view. Filesystem probes are local and best-effort. */
export async function buildWorkspaceManifest(
  projects: readonly ProjectListEntry[],
  readHead: (root: string) => Promise<string | null> = readHeadSha,
  readPackage: (root: string) => Promise<PackageMetadata | null> = readPackageMetadata,
): Promise<WorkspaceManifestResponse> {
  const repositories: WorkspaceManifestRepository[] = await Promise.all(
    projects
      .filter((project) => !project.unregistered)
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(async (project) => {
        const identity = githubIdentity(project.repoUrl);
        const candidateHead = project.status === 'ok' ? await readHead(project.root) : null;
        const head = candidateHead && /^[a-f0-9]{40,64}$/i.test(candidateHead)
          ? candidateHead.toLowerCase()
          : null;
        return {
          projectId: project.id,
          ...identity,
          branch: project.status === 'ok' ? project.branch ?? null : null,
          sha: head,
          visibility: 'unknown' as const,
          dependencyEdgeKinds: [...dependencyEdgeKinds],
        };
      }),
  );
  const registeredProjects = projects.filter((project) => !project.unregistered).slice().sort((a, b) => a.id.localeCompare(b.id));
  const packageMetadata = new Map<string, PackageMetadata | null>(await Promise.all(
    registeredProjects.map(async (project) => [project.id, await readPackage(project.root)] as const),
  ));
  const { edges, ambiguities } = discoverPackageEdges(packageMetadata);
  const revision = createHash('sha256').update(JSON.stringify({ repositories, edges, ambiguities })).digest('hex');
  return workspaceManifestResponseSchema.parse({ schemaVersion: 1, revision, repositories, edges, ambiguities });
}
