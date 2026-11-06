import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseManifest } from '../impact/manifest.ts';
import { analyzeOverlap } from '../impact/overlap.ts';
import { conflictConfusion, type PairOutcome } from './metrics.ts';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout.trim();

/**
 * Historical replay pilot (#202). For each pair of recent single-parent commits on a branch,
 * pretend both were independent concurrent changes branched from the older commit's parent:

 * Only adjacent commits are paired: a later commit can depend on anything between, which would read as a false conflict.
 * the analyzer predicts from each commit's changed files, and `git merge-tree` tells us whether
 * the two actually conflict. Output feeds `conflictConfusion`. This validates the deterministic
 * file-overlap rule against real history; it is an oracle-manifest measurement (the manifest is the
 * true diff), so it bounds the analyzer rule's accuracy, not the planner's prediction quality.
 */
export interface ReplayCommit { sha: string; parent: string; files: string[] }

export async function recentCommits(repoRoot: string, ref: string, count: number): Promise<ReplayCommit[]> {
  const log = await git(repoRoot, ['log', '--first-parent', '--no-merges', '--format=%H %P', `-n${count}`, ref]);
  const commits: ReplayCommit[] = [];
  for (const line of log.split('\n').filter(Boolean)) {
    const [sha, parent, ...extra] = line.trim().split(' ');
    if (!sha || !parent || extra.length > 0) continue; // skip roots and merges
    const files = (await git(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha])).split('\0').filter(Boolean);
    commits.push({ sha, parent, files });
  }
  return commits;
}

const IDENT = { GIT_AUTHOR_NAME: 'pilot', GIT_AUTHOR_EMAIL: 'pilot@example.invalid', GIT_COMMITTER_NAME: 'pilot', GIT_COMMITTER_EMAIL: 'pilot@example.invalid' };

/** Exit code 1 from merge-tree means conflicts; any other failure is a real error. */
async function mergeTree(repoRoot: string, args: string[]): Promise<{ conflicts: boolean; tree: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['merge-tree', '--write-tree', '--no-messages', ...args], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    return { conflicts: false, tree: stdout.trim().split(/\r?\n/)[0]! };
  } catch (error) {
    if ((error as { code?: number }).code === 1) return { conflicts: true, tree: '' };
    throw error;
  }
}

/**
 * Would `newer` have conflicted with `older` had it been developed in parallel from older's parent?
 * Re-base newer's diff onto older.parent (an inability to do so already means the work was dependent),
 * then merge that with older itself.
 */
async function actuallyConflicts(repoRoot: string, older: ReplayCommit, newer: ReplayCommit): Promise<boolean> {
  const replayed = await mergeTree(repoRoot, [`--merge-base=${newer.parent}`, older.parent, newer.sha]);
  if (replayed.conflicts) return true;
  const independent = (await execFileAsync('git', ['commit-tree', replayed.tree, '-p', older.parent, '-m', 'pilot'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...IDENT }, windowsHide: true })).stdout.trim();
  return (await mergeTree(repoRoot, [older.sha, independent])).conflicts;
}

export async function replayPairs(repoRoot: string, ref: string, options: { commits?: number; maxPairs?: number; repository?: string } = {}): Promise<{ pairs: PairOutcome[]; commitsConsidered: number; confusion: ReturnType<typeof conflictConfusion> }> {
  const repository = options.repository ?? 'pilot/repo';
  const commits = await recentCommits(repoRoot, ref, options.commits ?? 40);
  const toManifest = (c: ReplayCommit, n: number) => {
    const parsed = parseManifest({
      schemaVersion: 1, issue: { repository, number: n }, repo: { repository, branch: 'dev', baseSha: c.parent.slice(0, 40) }, manifestRevision: 1,
      generatedAt: new Date(0).toISOString(), mode: 'code-first', coverage: 'complete',
      files: c.files.filter((f) => !/[*?\\]/.test(f)).map((path) => ({ path, op: 'modify', confidence: 1, source: 'code-graph' })),
    });
    if (!parsed.ok) throw new Error(`pilot manifest invalid: ${parsed.errors.join('; ')}`);
    return parsed.manifest;
  };
  const pairs: PairOutcome[] = [];
  for (let i = 0; i < commits.length && pairs.length < (options.maxPairs ?? 200); i++) {
    for (let j = i + 1; j < Math.min(i + 2, commits.length) && pairs.length < (options.maxPairs ?? 200); j++) {
      const a = commits[i]!, b = commits[j]!;
      // commits are newest-first: a is newer than b; ask whether a could have been built in parallel with b
      const predicted = analyzeOverlap(toManifest(a, i + 1), toManifest(b, j + 1)).level;
      pairs.push({ predicted, actualConflict: await actuallyConflicts(repoRoot, b, a) });
    }
  }
  return { pairs, commitsConsidered: commits.length, confusion: conflictConfusion(pairs) };
}
