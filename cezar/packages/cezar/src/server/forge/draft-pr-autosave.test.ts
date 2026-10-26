import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftPr } from './github.ts';
import type { RunRecord } from '../../runs/store.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The pre-PR autosave is the LAST flush — unlike the turn-end and run-finalize
 * ones, no later autosave picks the work up. So when the conflict guard (#471)
 * refuses it, publishing must stop with a human-readable error rather than
 * pushing a branch that is missing the run's final state.
 */
describe('createDraftPr pre-PR autosave (#471 follow-up)', () => {
  let repo: string;
  let warn: ReturnType<typeof vi.spyOn>;

  const git = (args: string[]) => run('git', args, { cwd: repo });

  const input = () => ({
    repoRoot: repo,
    handoffText: '# Goal\n\nship it\n',
    run: { worktreePath: repo, branch: 'cez/abc123', task: 'do the thing' } as RunRecord,
  });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-draft-pr-'));
    await git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'base']);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('CEZ_DRY_RUN', '1'); // stop before push/gh; the guard runs earlier
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
  });

  it('disables terminal credential prompts for raw git pushes', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    const remote = mkdtempSync(join(tmpdir(), 'cez-push-remote-'));
    try {
      await run('git', ['init', '--bare', '-q', remote]);
      await git(['remote', 'add', 'origin', remote]);
      await git(['branch', 'cez/abc123']);
      writeFileSync(join(repo, '.git', 'hooks', 'pre-push'),
        '#!/bin/sh\necho "prompt-setting=$GIT_TERMINAL_PROMPT" >&2\nexit 1\n', { mode: 0o755 });
      const outcome = await createDraftPr(input());
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.error).toContain('prompt-setting=0');
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('refuses to publish a worktree holding conflict markers', async () => {
    writeFileSync(
      join(repo, 'a.txt'),
      ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> other', ''].join('\n'),
    );
    const outcome = await createDraftPr(input());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('unresolved merge conflicts');
  });

  it('refuses to publish an unresolved merge', async () => {
    await git([...GIT_ID, 'checkout', '-q', '-b', 'other']);
    writeFileSync(join(repo, 'a.txt'), 'theirs\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'theirs']);
    await git([...GIT_ID, 'checkout', '-q', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'ours\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'ours']);
    await git([...GIT_ID, 'merge', 'other']).catch(() => undefined); // expected to conflict

    const outcome = await createDraftPr(input());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('unresolved merge conflicts');
  });

  it('publishes normally when the worktree is clean', async () => {
    writeFileSync(join(repo, 'a.txt'), 'finished work\n');
    const outcome = await createDraftPr(input());
    expect(outcome.ok).toBe(true);
    // The final state landed on the branch before publishing.
    const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd: repo });
    expect(stdout.trim()).toBe('cezar autosave (pre-PR)');
  });

  it('publishes when there was nothing left to flush', async () => {
    const outcome = await createDraftPr(input());
    expect(outcome.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reuses the exact open head/base PR on replay without creating another', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    const calls: string[][] = [];
    const execute = vi.fn(async (args: string[], _cwd: string, bin: string) => {
      calls.push([bin, ...args]);
      if (bin === 'git' && args[0] === 'remote') return { ok: true, stdout: 'https://github.com/acme/repo.git', stderr: '', notFound: false };
      if (bin === 'git' && args[0] === 'push') return { ok: true, stdout: '', stderr: '', notFound: false };
      if (args[1] === 'list') return {
        ok: true,
        stdout: JSON.stringify([{ url: 'https://github.com/acme/repo/pull/42', headRefName: 'cez/abc123', baseRefName: 'dev' }]),
        stderr: '', notFound: false,
      };
      throw new Error(`unexpected tool call: ${bin} ${args.join(' ')}`);
    });

    const outcome = await createDraftPr({ ...input(), run: { ...input().run, baseBranch: 'origin/dev' } }, execute);
    expect(outcome).toEqual({ ok: true, url: 'https://github.com/acme/repo/pull/42', dryRun: false });
    expect(calls.some((call) => call[1] === 'pr' && call[2] === 'create')).toBe(false);
    expect(execute).toHaveBeenCalledWith(
      ['pr', 'list', '--head', 'cez/abc123', '--state', 'open', '--json', 'url,headRefName,baseRefName'],
      repo,
      'gh',
      60_000,
    );
  });

  it('resolves the repository default branch before matching or creating a PR', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    const execute = vi.fn(async (args: string[], _cwd: string, bin: string) => {
      if (bin === 'git' && args[0] === 'remote') return { ok: true, stdout: 'origin', stderr: '', notFound: false };
      if (bin === 'git' && args[0] === 'push') return { ok: true, stdout: '', stderr: '', notFound: false };
      if (args[0] === 'repo') return { ok: true, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }), stderr: '', notFound: false };
      if (args[1] === 'list') return { ok: true, stdout: '[]', stderr: '', notFound: false };
      if (args[1] === 'create') return { ok: true, stdout: 'https://github.com/acme/repo/pull/44', stderr: '', notFound: false };
      throw new Error(`unexpected tool call: ${bin} ${args.join(' ')}`);
    });

    const outcome = await createDraftPr(input(), execute);
    expect(outcome).toEqual({ ok: true, url: 'https://github.com/acme/repo/pull/44', dryRun: false });
    expect(execute).toHaveBeenCalledWith(['repo', 'view', '--json', 'defaultBranchRef'], repo, 'gh', 60_000);
    expect(execute.mock.calls.some(([args]) => args[1] === 'create' && args.includes('main'))).toBe(true);
  });

  it('reconciles a lost create response by finding the newly created PR', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    let listCalls = 0;
    const execute = vi.fn(async (args: string[], _cwd: string, bin: string) => {
      if (bin === 'git' && args[0] === 'remote') return { ok: true, stdout: 'origin', stderr: '', notFound: false };
      if (bin === 'git' && args[0] === 'push') return { ok: true, stdout: '', stderr: '', notFound: false };
      if (args[1] === 'list') {
        listCalls++;
        return {
          ok: true,
          stdout: JSON.stringify(listCalls === 1 ? [] : [{ url: 'https://github.com/acme/repo/pull/43', headRefName: 'cez/abc123', baseRefName: 'dev' }]),
          stderr: '', notFound: false,
        };
      }
      if (args[1] === 'create') return { ok: false, stdout: '', stderr: 'connection closed after create', notFound: false };
      throw new Error(`unexpected tool call: ${bin} ${args.join(' ')}`);
    });

    const outcome = await createDraftPr({ ...input(), run: { ...input().run, baseBranch: 'dev' } }, execute);
    expect(outcome).toEqual({ ok: true, url: 'https://github.com/acme/repo/pull/43', dryRun: false });
    expect(listCalls).toBe(2);
    expect(execute.mock.calls.filter(([args]) => args[1] === 'create')).toHaveLength(1);
  });

  it('fails closed when the PR lookup response is malformed', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    const execute = vi.fn(async (args: string[], _cwd: string, bin: string) => {
      if (bin === 'git' && args[0] === 'remote') return { ok: true, stdout: 'origin', stderr: '', notFound: false };
      if (bin === 'git' && args[0] === 'push') return { ok: true, stdout: '', stderr: '', notFound: false };
      if (args[1] === 'list') return { ok: true, stdout: '{bad json', stderr: '', notFound: false };
      throw new Error('PR create must not follow an unverifiable lookup');
    });

    const outcome = await createDraftPr({ ...input(), run: { ...input().run, baseBranch: 'dev' } }, execute);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('malformed JSON');
    expect(execute.mock.calls.some(([args]) => args[1] === 'create')).toBe(false);
  });
});
