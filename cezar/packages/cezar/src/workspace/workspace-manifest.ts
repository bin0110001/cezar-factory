import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  dependencyEdgeKindSchema,
  workspaceManifestResponseSchema,
  type WorkspaceManifestResponse,
  type WorkspaceManifestRepository,
} from '@open-mercato/cezar-contract';
import type { ProjectListEntry } from './projects.ts';

const execFile = promisify(execFileCallback);
const dependencyEdgeKinds = [...dependencyEdgeKindSchema.options];

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
  const revision = createHash('sha256').update(JSON.stringify(repositories)).digest('hex');
  return workspaceManifestResponseSchema.parse({ schemaVersion: 1, revision, repositories });
}
