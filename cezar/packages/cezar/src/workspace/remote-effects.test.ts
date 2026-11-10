import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginRemoteEffect,
  claimWorkspace,
  completeRemoteEffect,
  executeRemoteEffect,
  registerFactoryWorkspace,
} from './lifecycle.ts';
import { publishFactoryDraftPr, type FactoryDraftPrAdapter, type FactoryDraftPullRequest } from '../server/forge/github.ts';

const roots: string[] = [];

function repository(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'remote-effect-ledger-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'dev'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['-c', 'user.name=Effect Test', '-c', 'user.email=effect@example.test', 'add', 'base.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Effect Test', '-c', 'user.email=effect@example.test', 'commit', '-q', '-m', 'base'], { cwd: root });
  return { root, home: join(root, 'cez-home') };
}

async function firstOwner(root: string, home: string) {
  return claimWorkspace({ issue: '404', cwd: root, home, owner: 'external:effect-test:one', base: 'dev' });
}

function context(execution: { executionId: string; fencingToken: number }, attemptId: string) {
  return { issue: '404', executionId: execution.executionId, runId: execution.executionId, attemptId, fencingToken: execution.fencingToken };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fenced remote effect journal', () => {
  it('recovers PR creation after the remote succeeds but its response is lost', async () => {
    const { root, home } = repository();
    const owner = await firstOwner(root, home);
    const headSha = 'e'.repeat(40);
    let remoteHead: string | null = null;
    let remotePr: FactoryDraftPullRequest | null = null;
    let pushes = 0;
    let creates = 0;
    const adapter: FactoryDraftPrAdapter = {
      readRemoteHead: async () => remoteHead,
      isFastForward: async () => true,
      pushBranch: async () => { pushes++; remoteHead = headSha; },
      findOpenPullRequest: async () => remotePr,
      createPullRequest: async (input) => {
        creates++;
        remotePr = { ...input, number: 404, url: 'https://github.com/example/repo/pull/404' };
        throw new Error('simulated lost GitHub response');
      },
      updatePullRequest: async () => { throw new Error('unexpected update'); },
    };
    const result = await publishFactoryDraftPr({
      context: context(owner, 'agent-1:1'), branch: 'cez/issue-404', base: 'dev', headSha,
      remote: 'https://github.com/example/repo.git', title: 'Replay safe effects', body: 'Implementation details',
      adapter, cwd: root, home,
    });
    expect(result).toMatchObject({ number: 404, headSha, body: expect.stringContaining('Closes #404') });
    expect({ pushes, creates }).toEqual({ pushes: 1, creates: 1 });
  });

  it('reconciles an interrupted intent after a simulated remote success without repeating the call', async () => {
    const { root, home } = repository();
    const owner = await firstOwner(root, home);
    const request = { branch: 'cez/issue-404', headSha: 'a'.repeat(40), base: 'dev' };
    const now = Date.now();
    const initial = await beginRemoteEffect({ ...context(owner, 'agent-1:1'), cwd: root, home,
      effectKey: 'pr-create:cez/issue-404:dev', operation: 'pull-request.create', request, now });
    expect(initial.status).toBe('intent');

    // Simulate a worker dying after GitHub created the PR but before it persisted the URL.
    const remotePr = { number: 404, url: 'https://github.com/example/repo/pull/404', headSha: request.headSha };
    let createCalls = 0;
    const result = await executeRemoteEffect({ ...context(owner, 'agent-1:2'), cwd: root, home,
      effectKey: 'pr-create:cez/issue-404:dev', operation: 'pull-request.create', request,
      now: now + 3 * 60_000,
      reconcile: async () => remotePr,
      perform: async () => { createCalls++; return remotePr; },
    });
    expect(result).toEqual(remotePr);
    expect(createCalls).toBe(0);
  });

  it('retries an intent whose remote call never happened and completes it exactly once', async () => {
    const { root, home } = repository();
    const owner = await firstOwner(root, home);
    const request = { branch: 'cez/issue-404', headSha: 'b'.repeat(40) };
    const now = Date.now();
    await beginRemoteEffect({ ...context(owner, 'agent-1:1'), cwd: root, home,
      effectKey: 'branch-push:cez/issue-404:bbbb', operation: 'branch.push', request, now });
    let remoteHead: string | undefined;
    let pushCalls = 0;
    const result = await executeRemoteEffect({ ...context(owner, 'agent-1:2'), cwd: root, home,
      effectKey: 'branch-push:cez/issue-404:bbbb', operation: 'branch.push', request, now: now + 3 * 60_000,
      reconcile: async () => remoteHead === request.headSha ? { headSha: remoteHead } : null,
      perform: async () => { pushCalls++; remoteHead = request.headSha; return { headSha: remoteHead }; },
    });
    expect(result).toEqual({ headSha: request.headSha });
    expect(pushCalls).toBe(1);
  });

  it('rejects changed payloads and prevents a stale fence from completing a recovered intent', async () => {
    const { root, home } = repository();
    const owner = await firstOwner(root, home);
    const oldContext = context(owner, 'agent-1:1');
    const request = { branch: 'cez/issue-404', headSha: 'c'.repeat(40) };
    const now = Date.now();
    const first = await beginRemoteEffect({ ...oldContext, cwd: root, home,
      effectKey: 'branch-push:cez/issue-404:cccc', operation: 'branch.push', request, now });
    await expect(beginRemoteEffect({ ...context(owner, 'agent-1:2'), cwd: root, home,
      effectKey: 'branch-push:cez/issue-404:cccc', operation: 'branch.push', request: { ...request, headSha: 'd'.repeat(40) }, now: now + 3 * 60_000,
    })).rejects.toThrow(/different payload/i);

    const newer = await registerFactoryWorkspace({ issue: 404, runId: 'new-run', repoRoot: root, home,
      workspacePath: owner.workspacePath, baseCommit: owner.baseCommit, allowTerminalTransfer: true });
    const current = context(newer, 'agent-2:1');
    const resumed = await beginRemoteEffect({ ...current, cwd: root, home,
      effectKey: 'branch-push:cez/issue-404:cccc', operation: 'branch.push', request, now: now + 3 * 60_000 });
    await expect(completeRemoteEffect({ ...oldContext, cwd: root, home, effectKey: 'branch-push:cez/issue-404:cccc',
      requestHash: first.requestHash, claimToken: first.claimToken, result: { headSha: request.headSha }, now: now + 4 * 60_000,
    })).rejects.toThrow(/stale|fenced/i);
    await expect(completeRemoteEffect({ ...current, cwd: root, home, effectKey: 'branch-push:cez/issue-404:cccc',
      requestHash: resumed.requestHash, claimToken: resumed.claimToken, result: { headSha: request.headSha }, now: now + 4 * 60_000,
    })).resolves.toMatchObject({ status: 'completed' });
  });
});
