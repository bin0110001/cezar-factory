// Usage: node --import tsx scripts/pilot-replay.mjs <repo-path> <ref> [commits]
// Runs the historical overlap replay against a throwaway local clone so the source repository gets no new objects.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayPairs } from '../src/server/backlog/pilot-replay.ts';

const [, , source, ref = 'HEAD', commits = '60'] = process.argv;
if (!source) { console.error('usage: pilot-replay.mjs <repo-path> <ref> [commits]'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'cez-pilot-clone-'));
try {
  execFileSync('git', ['clone', '--quiet', '--no-checkout', '--local', '--no-hardlinks', source, dir], { stdio: 'pipe' });
  const resolved = execFileSync('git', ['rev-parse', '--verify', ref], { cwd: source, encoding: 'utf8' }).trim();
  const result = await replayPairs(dir, resolved, { commits: Number(commits), maxPairs: 500, repository: 'pilot/repo' });
  console.log(JSON.stringify({ source, ref, resolved, commitsConsidered: result.commitsConsidered, pairs: result.pairs.length, ...result.confusion }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
