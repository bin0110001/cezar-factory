import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayPairs } from './pilot-replay.ts';

const ID = ['-c', 'user.name=T', '-c', 'user.email=t@example.test'];
let repo: string;
const git = (...a: string[]) => execFileSync('git', [...ID, ...a], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (file: string, content: string, msg: string) => { writeFileSync(join(repo, file), content); git('add', file); git('commit', '-q', '-m', msg); };

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'cez-pilot-')); git('init', '-q', '-b', 'dev'); commit('shared.txt', 'a\nb\nc\nd\ne\n', 'base'); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('historical replay pilot', () => {
  it('compares file-overlap predictions with real conflicts from history', async () => {
    commit('x.txt', 'x1\n', 'add x');
    commit('y.txt', 'y1\n', 'add y');                       // disjoint from x: no overlap, no conflict
    writeFileSync(join(repo, 'shared.txt'), 'A\nb\nc\nd\ne\n'); git('add', '.'); git('commit', '-q', '-m', 'edit top');
    writeFileSync(join(repo, 'shared.txt'), 'A\nb\nc\nd\nE\n'); git('add', '.'); git('commit', '-q', '-m', 'edit bottom'); // same file, distant hunks: overlap but merges cleanly
    writeFileSync(join(repo, 'shared.txt'), 'A\nb\nc\nd\nEE\n'); git('add', '.'); git('commit', '-q', '-m', 'edit bottom again'); // same lines: real conflict
    const result = await replayPairs(repo, 'dev', { commits: 6, repository: 'o/r' });
    expect(result.commitsConsidered).toBe(5);
    const c = result.confusion;
    expect(c.truePositive).toBeGreaterThanOrEqual(1);     // the bottom/bottom-again pair
    expect(c.falsePositive).toBeGreaterThanOrEqual(1);    // top/bottom: same file, no conflict
    expect(c.trueNegative).toBeGreaterThanOrEqual(1);     // x/y
    expect(c.falseNegative).toBe(0);                      // file overlap never misses a textual conflict
    expect(c.unknown).toBe(0);
    expect(c.recall).toBe(1);
  }, 30_000);
});
