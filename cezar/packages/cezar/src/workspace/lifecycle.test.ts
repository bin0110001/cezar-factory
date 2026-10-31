import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWorkspaceHookContext, integratedIssueLabelEdits, reconcileReadyWorkspaceIntegrations, runPostMergeValidation, runWorkspaceCommand } from './lifecycle-cli.ts';
import {
  adoptWorkspace, claimWorkspace, factoryWorkflowParticipatesInWorkspaceLifecycle, heartbeatWorkspace, lifecycleDoctor, lifecycleEvents, lifecycleMetrics, lifecycleStatus,
  acquireIntegrationLock, completeIntegration, factoryContextForRun, handoffWorkspace,
  pruneWorkspace, registerFactoryWorkspace, releaseIntegrationLock, transitionWorkspace, verifiedFactoryContext,
  recordIntegrationValidationFailure,
  lifecycleOutbox, drainLifecycleOutbox,
  workspaceOverlaps, reconcileWorkspaceLifecycle,
  recoverWorkspace, resumeBlockedWorkspace, approveHindsightLesson,
  recordWorkspacePreflight, renewReadyWorkspaceLease,
} from './lifecycle.ts';

const GIT_ID = ['-c', 'user.name=Lifecycle Test', '-c', 'user.email=lifecycle@example.test'];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('local workspace lifecycle', () => {
  let home: string;
  let repo: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-lifecycle-home-'));
    repo = mkdtempSync(join(tmpdir(), 'cez-lifecycle-repo-'));
    oldHome = process.env.CEZ_HOME;
    process.env.CEZ_HOME = home;
    git(repo, 'init', '-q', '-b', 'dev');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ...GIT_ID, 'add', 'base.txt');
    git(repo, ...GIT_ID, 'commit', '-q', '-m', 'base');
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('registers claims only for Factory workflows that perform lifecycle handoff', () => {
    expect(['factory-implement', 'factory-review', 'factory-fix-review'].every(factoryWorkflowParticipatesInWorkspaceLifecycle)).toBe(true);
    expect(['factory-plan', 'factory-intake', 'factory-investigate', 'factory-godot-upgrade'].some(factoryWorkflowParticipatesInWorkspaceLifecycle)).toBe(false);
  });

  it('upgrades a version 2 telemetry outbox without losing its delivery history', async () => {
    const commonRaw = git(repo, 'rev-parse', '--git-common-dir');
    const commonDir = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(repo, commonRaw));
    const repoId = createHash('sha256').update(commonDir.toLowerCase()).digest('hex').slice(0, 24);
    const registryDir = join(home, 'workspace-lifecycle', repoId);
    mkdirSync(registryDir, { recursive: true });
    const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => {
      exec(sql: string): void; prepare(sql: string): { all(): Array<Record<string, unknown>> }; close(): void;
    };
    const db = new Database(join(registryDir, 'registry.sqlite'));
    db.exec(`PRAGMA user_version=2;
      CREATE TABLE events(seq INTEGER PRIMARY KEY,event_id TEXT UNIQUE,repo_id TEXT,issue_key TEXT,execution_id TEXT,event_type TEXT,timestamp TEXT,payload_json TEXT);
      CREATE TABLE event_outbox(event_id TEXT,destination TEXT,status TEXT,attempts INTEGER,next_attempt_at TEXT,last_error TEXT,delivered_at TEXT,created_at TEXT,PRIMARY KEY(event_id,destination));`);
    db.close();
    await expect(lifecycleOutbox({ cwd: repo })).resolves.toMatchObject({ pending: 0, failed: 0, delivered: 0 });
    const migrated = new Database(join(registryDir, 'registry.sqlite'));
    expect(migrated.prepare('PRAGMA user_version').all()[0]?.user_version).toBe(3);
    expect(migrated.prepare('PRAGMA table_info(event_outbox)').all().some((column) => column.name === 'approved_at')).toBe(true);
    migrated.close();
  });

  it('claims one isolated issue worktree and rejects another active owner', async () => {
    const claim = await claimWorkspace({ issue: '42', cwd: repo, owner: 'external:test:100', base: 'dev' });
    expect(claim.state).toBe('working');
    expect(claim.origin).toBe('factory-created');
    expect(claim.branch).toBe('factory/issue-42');
    expect(claim.workspacePath).toContain(join('.ai', 'cezar', 'workspaces', 'issue-42'));
    expect(git(claim.workspacePath, 'status', '--porcelain')).toBe('');
    const resumed = await claimWorkspace({ issue: '42', cwd: claim.workspacePath, owner: 'external:test:100', base: 'dev' });
    expect(resumed.executionId).toBe(claim.executionId);
    expect(resumed.workspacePath).toBe(claim.workspacePath);
    expect(existsSync(join(claim.workspacePath, '.ai', 'cezar', 'workspaces', 'issue-42'))).toBe(false);
    await expect(claimWorkspace({ issue: '42', cwd: repo, owner: 'external:test:101', base: 'dev' }))
      .rejects.toThrow('already has active execution');
    expect((await lifecycleStatus({ cwd: repo })).map((row) => row.issue)).toEqual(['42']);
    const stopHook = await buildWorkspaceHookContext({ cwd: claim.workspacePath }, 'Stop', {});
    expect(JSON.stringify(stopHook)).toContain('still working');
  });

  it('automatically reconciles a ready claim after its matching PR is merged', async () => {
    const claim = await claimWorkspace({ issue: '46', cwd: repo, owner: 'external:test:46', base: 'dev' });
    await transitionWorkspace({ issue: '46', to: 'validating', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    await transitionWorkspace({ issue: '46', to: 'ready', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    const discover = async (record: { issue: string }, target: string, cwd: string) => {
      expect(record.issue).toBe('46');
      expect(target).toBe('dev');
      expect(cwd).toBe(repo);
      return { url: 'https://github.com/example/repo/pull/46', headRefOid: 'a'.repeat(40), mergeCommit: { oid: 'b'.repeat(40) } };
    };
    const integrated: string[] = [];
    const result = await reconcileReadyWorkspaceIntegrations({
      cwd: repo, discover,
      integratePr: async (issue, pr) => { integrated.push(`${issue}:${pr}`); },
    });
    expect(integrated).toEqual(['46:https://github.com/example/repo/pull/46']);
    expect(result).toEqual([{ issue: '46', status: 'integrated' }]);
  });

  it('retains a ready lease under its fence while waiting for a remote merge', async () => {
    const claim = await claimWorkspace({ issue: '49', cwd: repo, owner: 'external:test:49', base: 'dev', minutes: 1 });
    await transitionWorkspace({ issue: '49', to: 'validating', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    const ready = await transitionWorkspace({ issue: '49', to: 'ready', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    const renewed = await renewReadyWorkspaceLease({ issue: '49', cwd: repo, executionId: ready.executionId, fencingToken: ready.fencingToken, minutes: 30 });
    expect(Date.parse(renewed.leaseExpiresAt)).toBeGreaterThan(Date.now() + 15 * 60_000);
    await expect(renewReadyWorkspaceLease({ issue: '49', cwd: repo, executionId: ready.executionId, fencingToken: ready.fencingToken + 1 }))
      .rejects.toThrow('stale');
  });

  it('keeps ready claims queued when GitHub has no merged PR or integration fails', async () => {
    const claim = await claimWorkspace({ issue: '47', cwd: repo, owner: 'external:test:47', base: 'dev' });
    await transitionWorkspace({ issue: '47', to: 'validating', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    await transitionWorkspace({ issue: '47', to: 'ready', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    const pending = await reconcileReadyWorkspaceIntegrations({ cwd: repo, discover: async () => null });
    expect(pending).toEqual([{ issue: '47', status: 'pending' }]);
    const failed = await reconcileReadyWorkspaceIntegrations({
      cwd: repo,
      discover: async () => ({ url: 'https://github.com/example/repo/pull/47', headRefOid: 'a'.repeat(40), mergeCommit: { oid: 'b'.repeat(40) } }),
      integratePr: async () => { throw new Error('post-merge validation failed'); },
    });
    expect(failed).toEqual([{ issue: '47', status: 'failed', detail: 'post-merge validation failed' }]);
    expect((await lifecycleStatus({ cwd: repo, issue: '47' }))[0]?.state).toBe('ready');
  });

  it('retains an integrated workspace as a retry queue when GitHub issue bookkeeping is offline', async () => {
    const claim = await claimWorkspace({ issue: '48', cwd: repo, owner: 'external:test:48', base: 'dev' });
    await transitionWorkspace({ issue: '48', to: 'validating', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    await transitionWorkspace({ issue: '48', to: 'ready', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    const lockToken = await acquireIntegrationLock({ issue: '48', executionId: claim.executionId, fencingToken: claim.fencingToken, targetBranch: 'dev', cwd: repo });
    await transitionWorkspace({ issue: '48', to: 'integrating', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    await completeIntegration({
      issue: '48', executionId: claim.executionId, fencingToken: claim.fencingToken,
      targetBranch: 'dev', pullRequest: 'https://github.com/example/repo/pull/48',
      headCommit: git(claim.workspacePath, 'rev-parse', 'HEAD'), integratedCommit: git(repo, 'rev-parse', 'dev'),
      integrationLockToken: lockToken, cwd: repo,
    });
    const failed = await reconcileReadyWorkspaceIntegrations({ cwd: repo, syncIssueState: async () => { throw new Error('GitHub unavailable'); } });
    expect(failed).toEqual([{ issue: '48', status: 'failed', detail: 'GitHub unavailable' }]);
    expect((await lifecycleStatus({ cwd: repo, issue: '48' }))[0]?.state).toBe('integrated');
    expect(existsSync(claim.workspacePath)).toBe(true);
    const recovered = await reconcileReadyWorkspaceIntegrations({ cwd: repo, syncIssueState: async () => undefined });
    expect(recovered).toEqual([{ issue: '48', status: 'integrated' }]);
    expect(existsSync(claim.workspacePath)).toBe(false);
    expect((await lifecycleStatus({ cwd: repo, issue: '48' })).length).toBe(0);
  }, 20_000);

  it('refuses to claim a pre-existing unregistered worktree as Factory-created', async () => {
    const path = join(repo, '.ai', 'cezar', 'workspaces', 'issue-43');
    git(repo, 'worktree', 'add', '-q', '-b', 'factory/issue-43', path, 'dev');
    await expect(claimWorkspace({ issue: '43', cwd: repo, owner: 'external:test:43', base: 'dev' }))
      .rejects.toThrow('without an active lifecycle claim');
    expect((await lifecycleStatus({ cwd: repo, issue: '43' })).length).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('prevents two active issue claims from sharing one adopted workspace', async () => {
    const first = await adoptWorkspace({ issue: '44', cwd: repo, owner: 'external:test:44' });
    await expect(adoptWorkspace({ issue: '45', cwd: first.workspacePath, owner: 'external:test:45' }))
      .rejects.toThrow('already owned by active issue 44');
    expect((await lifecycleStatus({ cwd: repo })).map((row) => row.issue)).toContain('44');
    expect((await lifecycleStatus({ cwd: repo })).map((row) => row.issue)).not.toContain('45');
  });

  it('stores configured telemetry destinations transactionally in the local outbox', async () => {
    const oldKey = process.env.LANGFUSE_PUBLIC_KEY;
    const oldSecret = process.env.LANGFUSE_SECRET_KEY;
    const oldHost = process.env.LANGFUSE_HOST;
    process.env.LANGFUSE_PUBLIC_KEY = 'test-public-key';
    process.env.LANGFUSE_SECRET_KEY = 'test-secret-key';
    process.env.LANGFUSE_HOST = 'http://127.0.0.1:1';
    try {
      await claimWorkspace({ issue: '1001', cwd: repo, owner: 'external:test:outbox' });
      const queue = await lifecycleOutbox({ cwd: repo });
      expect(queue.pending).toBeGreaterThan(0);
      expect(queue.next.some((item) => item.destination === 'langfuse' && item.type === 'claimed')).toBe(true);
    } finally {
      if (oldKey === undefined) delete process.env.LANGFUSE_PUBLIC_KEY; else process.env.LANGFUSE_PUBLIC_KEY = oldKey;
      if (oldSecret === undefined) delete process.env.LANGFUSE_SECRET_KEY; else process.env.LANGFUSE_SECRET_KEY = oldSecret;
      if (oldHost === undefined) delete process.env.LANGFUSE_HOST; else process.env.LANGFUSE_HOST = oldHost;
    }
  });

  it('delivers queued Langfuse events through OTLP and records per-destination success', async () => {
    const names = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST'] as const;
    const old = names.map((key) => process.env[key]);
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test'; process.env.LANGFUSE_SECRET_KEY = 'sk-test'; process.env.LANGFUSE_HOST = 'http://langfuse.test';
    let posted: Record<string, unknown> | undefined;
    try {
      await claimWorkspace({ issue: '1002', cwd: repo, owner: 'external:test:outbox-deliver' });
      let requests = 0;
      const fetcher: typeof fetch = async (input, init) => {
        requests++;
        expect(String(input)).toBe('http://langfuse.test/api/public/otel/v1/traces');
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 75));
        return new Response(null, { status: 200 });
      };
      const results = await Promise.all([
        drainLifecycleOutbox({ cwd: repo, fetcher }),
        drainLifecycleOutbox({ cwd: repo, fetcher }),
      ]);
      expect(results.reduce((total, result) => total + result.delivered, 0)).toBe(1);
      expect(requests).toBe(1);
      expect(posted?.resourceSpans).toBeDefined();
      expect((await lifecycleOutbox({ cwd: repo })).delivered).toBeGreaterThan(0);
    } finally {
      names.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
    }
  });

  it('requires explicit approval before asynchronously retaining a resolved conflict lesson', async () => {
    const names = ['HINDSIGHT_URL', 'HINDSIGHT_PROJECT_BANK', 'HINDSIGHT_AUTH_TOKEN', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST'] as const;
    const old = names.map((key) => process.env[key]);
    process.env.HINDSIGHT_URL = 'http://hindsight.test'; process.env.HINDSIGHT_PROJECT_BANK = 'project-test'; process.env.HINDSIGHT_AUTH_TOKEN = 'token-test';
    delete process.env.LANGFUSE_PUBLIC_KEY; delete process.env.LANGFUSE_SECRET_KEY; delete process.env.LANGFUSE_HOST;
    try {
      const claim = await claimWorkspace({ issue: '1003', cwd: repo, owner: 'external:test:hindsight' });
      await recordWorkspacePreflight({ issue: claim.issue, executionId: claim.executionId, fencingToken: claim.fencingToken,
        targetBranch: 'dev', targetRef: 'refs/remotes/origin/dev', targetCommit: 'a'.repeat(40), branchCommit: 'b'.repeat(40),
        conflictingPaths: ['src/example.ts'], cwd: repo });
      await recordWorkspacePreflight({ issue: claim.issue, executionId: claim.executionId, fencingToken: claim.fencingToken,
        targetBranch: 'dev', targetRef: 'refs/remotes/origin/dev', targetCommit: 'c'.repeat(40), branchCommit: 'd'.repeat(40),
        conflictingPaths: [], cwd: repo });
      const candidate = (await lifecycleOutbox({ cwd: repo })).next.find((item) => item.destination === 'hindsight');
      expect(candidate?.type).toBe('preflight_repaired');
      await expect(drainLifecycleOutbox({ cwd: repo, fetcher: async () => { throw new Error('must await approval'); } }))
        .resolves.toMatchObject({ delivered: 0 });
      await expect(approveHindsightLesson({ eventId: candidate!.eventId, cwd: repo })).resolves.toMatchObject({ approved: true });
      const methods: string[] = [];
      const result = await drainLifecycleOutbox({ cwd: repo, fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        methods.push(request.method);
        if (request.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'Mcp-Session-Id': 'session-test' } });
        if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
        expect(request.params.name).toBe('retain');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"id":"memory-test"}' }] } }), { status: 200 });
      } });
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
      expect(result.delivered).toBe(1);
      expect((await lifecycleOutbox({ cwd: repo })).delivered).toBe(1);
    } finally {
      names.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
    }
  }, 20_000);

  it('adopts a dirty developer worktree without changing its files or scheduling cleanup', async () => {
    const adoptedPath = join(repo, 'developer-worktree');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/existing', adoptedPath, 'dev');
    const changed = join(adoptedPath, 'local.txt');
    writeFileSync(changed, 'keep this work\n');
    const before = git(adoptedPath, 'status', '--porcelain');
    const adopted = await adoptWorkspace({ issue: '#7', cwd: adoptedPath, owner: 'external:test:200' });
    expect(adopted.origin).toBe('adopted');
    expect(adopted.workspacePath).toBe(realpathSync(adoptedPath));
    expect(git(adoptedPath, 'status', '--porcelain')).toBe(before);
    expect(await pruneWorkspace({ issue: '7', cwd: adoptedPath })).toEqual({
      removed: false, reason: 'Adopted developer workspaces are retained.',
    });
    expect(existsSync(changed)).toBe(true);
    for (const to of ['validating', 'ready', 'integrating', 'integrated', 'cleanup_pending'] as const) {
      await transitionWorkspace({ issue: '7', to, cwd: adoptedPath, executionId: adopted.executionId, fencingToken: adopted.fencingToken });
    }
    const reconciliation = await reconcileWorkspaceLifecycle({ cwd: adoptedPath });
    expect(reconciliation.findings).not.toContain('Issue 7: adopted workspace must never be pruned automatically.');
    expect(existsSync(changed)).toBe(true);
    expect(await lifecycleStatus({ cwd: adoptedPath, issue: '7' })).toEqual([]);
  });

  it('reconciles the integrated Factory label exclusively among workflow states', () => {
    expect(integratedIssueLabelEdits(['factory:review', 'factory:blocked', 'factory:auditing', 'risk:low']))
      .toEqual({ add: ['factory:done'], remove: ['factory:review', 'factory:blocked'] });
    expect(integratedIssueLabelEdits(['factory:done', 'factory:auditing'])).toEqual({ add: [], remove: [] });
  });

  it('persists post-merge validation attempts under the execution fence', async () => {
    const claim = await claimWorkspace({ issue: '318', cwd: repo, owner: 'external:test:318', base: 'dev' });
    for (const to of ['validating', 'ready', 'integrating'] as const) {
      await transitionWorkspace({ issue: '318', to, cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    }
    const attempts = [];
    for (let i = 0; i < 3; i++) attempts.push(await recordIntegrationValidationFailure({
      issue: '318', executionId: claim.executionId, fencingToken: claim.fencingToken, detail: 'validation failed', cwd: repo,
    }));
    expect(attempts).toEqual([1, 2, 3]);
    expect((await lifecycleEvents({ issue: '318', cwd: repo, limit: 10 })).slice(0, 3)).toMatchObject([
      { type: 'integration_validation_failed', payload: { attempt: 3 } },
      { type: 'integration_validation_failed', payload: { attempt: 2 } },
      { type: 'integration_validation_failed', payload: { attempt: 1 } },
    ]);
    await transitionWorkspace({ issue: '318', to: 'blocked', cwd: repo, executionId: claim.executionId, fencingToken: claim.fencingToken });
    expect(await lifecycleStatus({ issue: '318', cwd: repo })).toMatchObject([{ state: 'blocked' }]);
    await expect(reconcileReadyWorkspaceIntegrations({ cwd: repo, discover: async () => { throw new Error('blocked issue must not retry'); } }))
      .resolves.toEqual([]);
  });

  it('treats malformed merged-tree validation policy as a post-merge validation failure', async () => {
    const mergedTree = mkdtempSync(join(tmpdir(), 'cez-invalid-merged-policy-'));
    try {
      writeFileSync(join(mergedTree, 'workspace-lifecycle.json'), '{');
      await expect(runPostMergeValidation(mergedTree)).rejects.toThrow();
    } finally { rmSync(mergedTree, { recursive: true, force: true }); }
  });

  it('preflights a clean integration and returns repair context for conflicting paths', async () => {
    const clean = await claimWorkspace({ issue: '301', cwd: repo, owner: 'external:test:301', base: 'dev' });
    writeFileSync(join(clean.workspacePath, 'issue-301.txt'), 'independent change\n');
    git(clean.workspacePath, ...GIT_ID, 'add', 'issue-301.txt');
    git(clean.workspacePath, ...GIT_ID, 'commit', '-q', '-m', 'independent issue change');
    git(repo, 'update-ref', 'refs/remotes/origin/dev', git(repo, 'rev-parse', 'dev'));
    const cleanOutput: string[] = [];
    expect(await runWorkspaceCommand(['preflight', '--issue', '301', '--json'], {
      cwd: repo, io: { log: (line) => cleanOutput.push(line), error: (line) => { throw new Error(line); } },
    })).toBe(0);
    expect(JSON.parse(cleanOutput.join('\n'))).toMatchObject({ issue: '301', status: 'clean', targetBranch: 'dev', targetRef: 'refs/remotes/origin/dev' });

    writeFileSync(join(repo, 'overlap.txt'), 'base line\n');
    git(repo, ...GIT_ID, 'add', 'overlap.txt');
    git(repo, ...GIT_ID, 'commit', '-q', '-m', 'add shared file');
    const conflicting = await claimWorkspace({ issue: '302', cwd: repo, owner: 'external:test:302', base: 'dev' });
    writeFileSync(join(conflicting.workspacePath, 'overlap.txt'), 'issue version\n');
    git(conflicting.workspacePath, ...GIT_ID, 'add', 'overlap.txt');
    git(conflicting.workspacePath, ...GIT_ID, 'commit', '-q', '-m', 'change shared file in issue');
    writeFileSync(join(repo, 'overlap.txt'), 'target version\n');
    git(repo, ...GIT_ID, 'add', 'overlap.txt');
    git(repo, ...GIT_ID, 'commit', '-q', '-m', 'change shared file on target');
    git(repo, 'update-ref', 'refs/remotes/origin/dev', git(repo, 'rev-parse', 'dev'));
    const conflictOutput: string[] = [];
    expect(await runWorkspaceCommand(['preflight', '--issue', '302', '--json'], {
      cwd: repo, io: { log: (line) => conflictOutput.push(line), error: (line) => { throw new Error(line); } },
    })).toBe(2);
    const result = JSON.parse(conflictOutput.join('\n')) as {
      status: string; conflictingPaths: string[]; repairContext?: { diagnostics?: string; branchCommit?: string; targetCommit?: string };
    };
    expect(result.status).toBe('conflicts');
    expect(result.conflictingPaths).toContain('overlap.txt');
    expect(result.repairContext?.diagnostics).toContain('overlap.txt');
    expect(result.repairContext?.branchCommit).toBeTruthy();
    expect(result.repairContext?.targetCommit).toBeTruthy();
    const conflictEvents = await lifecycleEvents({ cwd: repo, issue: '302' });
    expect(conflictEvents[0]).toMatchObject({ type: 'preflight_conflicts', payload: {
      targetBranch: 'dev', conflictingPaths: ['overlap.txt'],
    } });
    expect(JSON.stringify(conflictEvents[0]?.payload)).toContain('CONFLICT (content)');
    expect(await runWorkspaceCommand(['preflight', '--issue', '302', '--json'], {
      cwd: repo, io: { log: () => undefined, error: (line) => { throw new Error(line); } },
    })).toBe(2);
    expect((await lifecycleStatus({ cwd: repo, issue: '302' }))[0]?.state).toBe('blocked');
    expect(await lifecycleMetrics({ cwd: repo })).toMatchObject({
      activeWorkspaces: 2, preflightCount: 3, conflictCount: 2, conflictRate: 2 / 3, conflictEscalations: 1,
      autoRepairAttempts: 1, autoRepairSuccesses: 0, autoRepairSuccessRate: 0,
      conflictCategories: { 'source-or-other': 2 },
      cleanupBacklog: 0,
    });
    await expect(resumeBlockedWorkspace({ issue: '302', cwd: repo })).resolves.toMatchObject({ state: 'working' });
    expect((await lifecycleMetrics({ cwd: repo })).manualInterventions).toBe(1);
    let mergeError = '';
    try { execFileSync('git', [...GIT_ID, 'merge', 'origin/dev'], { cwd: conflicting.workspacePath, encoding: 'utf8' }); }
    catch (error) { mergeError = String((error as { stderr?: string }).stderr ?? error); /* expected content conflict, resolved below */ }
    writeFileSync(join(conflicting.workspacePath, 'overlap.txt'), 'reconciled issue and target change\n');
    git(conflicting.workspacePath, ...GIT_ID, 'add', 'overlap.txt');
    git(conflicting.workspacePath, ...GIT_ID, 'commit', '-q', '-m', 'resolve integration conflict');
    const repairedOutput: string[] = [];
    const repairedStatus = await runWorkspaceCommand(['preflight', '--issue', '302', '--json'], {
      cwd: repo, io: { log: (line) => repairedOutput.push(line), error: (line) => { throw new Error(line); } },
    });
    const targetHead = git(repo, 'rev-parse', 'dev');
    const repairedParents = git(conflicting.workspacePath, 'rev-list', '--parents', '-n', '1', 'HEAD');
    expect(repairedStatus, `merge=${mergeError}\ntarget=${targetHead}\nbranch=${repairedParents}\n${repairedOutput.join('\n')}`).toBe(0);
    expect(await lifecycleMetrics({ cwd: repo })).toMatchObject({
      autoRepairAttempts: 1, autoRepairSuccesses: 1, autoRepairSuccessRate: 1,
    });
  }, 20_000);

  it('reports overlapping changed paths as advisory workspace context', async () => {
    const first = await claimWorkspace({ issue: '51', cwd: repo, owner: 'external:test:510', base: 'dev' });
    const second = await claimWorkspace({ issue: '52', cwd: repo, owner: 'external:test:520', base: 'dev' });
    writeFileSync(join(first.workspacePath, 'shared.ts'), 'first');
    writeFileSync(join(second.workspacePath, 'shared.ts'), 'second');
    writeFileSync(join(second.workspacePath, 'separate.ts'), 'second only');
    expect(await workspaceOverlaps({ cwd: repo })).toEqual([{
      issues: ['51', '52'], paths: ['shared.ts'],
      workspaces: [first.workspacePath, second.workspacePath],
    }]);
  });

  it('recovers a stale execution with a higher fence and preserves its workspace', async () => {
    const claim = await claimWorkspace({ issue: '53', cwd: repo, owner: 'external:test:530', base: 'dev' });
    const recovered = await recoverWorkspace({ issue: '53', cwd: repo, force: true, owner: 'external:test:531' });
    expect(recovered.executionId).not.toBe(claim.executionId);
    expect(recovered.fencingToken).toBe(claim.fencingToken + 1);
    expect(recovered.workspacePath).toBe(claim.workspacePath);
    expect((await lifecycleEvents({ cwd: repo, issue: '53' }))[0]).toMatchObject({
      type: 'recovered', payload: { previousExecutionId: claim.executionId, forced: true },
    });
    await expect(heartbeatWorkspace({
      issue: '53', executionId: claim.executionId, fencingToken: claim.fencingToken, cwd: repo,
    })).rejects.toThrow('stale');
    expect(existsSync(claim.workspacePath)).toBe(true);
  });

  it('cleans the scheduler-owned task worktree after verified integration', async () => {
    const worktree = join(repo, '.ai', 'cezar', 'worktrees', 'factory-run-54');
    const base = git(repo, 'rev-parse', 'dev');
    const runTree = await import('../git-worktree.ts').then(({ createWorktree }) => createWorktree(repo, 'factory-run-54', base));
    expect(runTree.path).toBe(worktree);
    const claim = await registerFactoryWorkspace({
      issue: 54, runId: 'factory-run-54', repoRoot: repo, workspacePath: worktree, baseCommit: base,
    });
    for (const to of ['validating', 'ready', 'integrating', 'integrated', 'cleanup_pending'] as const) {
      await transitionWorkspace({ issue: '54', to, executionId: claim.executionId, fencingToken: claim.fencingToken, cwd: repo });
    }
    expect((await pruneWorkspace({ issue: '54', cwd: repo })).removed).toBe(true);
    expect(existsSync(worktree)).toBe(false);
  });

  it('finishes cleanup when a crash removed the integrated worktree before the registry closed it', async () => {
    const claim = await claimWorkspace({ issue: '55', cwd: repo, owner: 'external:test:550', base: 'dev' });
    for (const to of ['validating', 'ready', 'integrating', 'integrated', 'cleanup_pending'] as const) {
      await transitionWorkspace({ issue: '55', to, executionId: claim.executionId, fencingToken: claim.fencingToken, cwd: repo });
    }
    git(repo, 'worktree', 'remove', claim.workspacePath);
    const report = await reconcileWorkspaceLifecycle({ cwd: repo });
    expect(report.cleaned).toContain('55');
    expect(report.findings.some((finding) => finding.includes('Issue 55: registry workspace is missing'))).toBe(false);
    expect(await lifecycleStatus({ cwd: repo, issue: '55' })).toEqual([]);
  });

  it('uses fencing for heartbeats and removes only an integrated, clean Factory workspace', async () => {
    const claim = await claimWorkspace({ issue: '9', cwd: repo, owner: 'external:test:300', base: 'dev' });
    const beat = await heartbeatWorkspace({ issue: '9', executionId: claim.executionId, fencingToken: claim.fencingToken, cwd: repo });
    expect(Date.parse(beat.leaseExpiresAt)).toBeGreaterThan(Date.now());
    await expect(heartbeatWorkspace({ issue: '9', executionId: claim.executionId, fencingToken: claim.fencingToken + 1, cwd: repo }))
      .rejects.toThrow('fenced');
    for (const to of ['validating', 'ready'] as const) {
      await transitionWorkspace({ issue: '9', to, executionId: claim.executionId, fencingToken: claim.fencingToken, cwd: repo });
    }
    const lockToken = await acquireIntegrationLock({ issue: '9', executionId: claim.executionId, fencingToken: claim.fencingToken, targetBranch: 'dev', cwd: repo });
    await transitionWorkspace({ issue: '9', to: 'integrating', executionId: claim.executionId, fencingToken: claim.fencingToken, cwd: repo });
    const integrated = await completeIntegration({
      issue: '9', executionId: claim.executionId, fencingToken: claim.fencingToken, targetBranch: 'dev',
      pullRequest: '42', headCommit: git(claim.workspacePath, 'rev-parse', 'HEAD'),
      integratedCommit: git(repo, 'rev-parse', 'dev'), integrationLockToken: lockToken, cwd: repo,
    });
    expect(integrated.state).toBe('integrated');
    expect(await lifecycleMetrics({ cwd: repo })).toMatchObject({
      completedIntegrations: 1, cleanupBacklog: 1,
    });
    expect((await lifecycleMetrics({ cwd: repo })).averageTimeToIntegrationMs).toBeGreaterThanOrEqual(0);
    const startup = await reconcileWorkspaceLifecycle({ cwd: repo });
    expect(startup.cleaned).not.toContain('9');
    expect(existsSync(claim.workspacePath)).toBe(true);
    const reconciled = await reconcileReadyWorkspaceIntegrations({ cwd: repo, syncIssueState: async () => undefined });
    await releaseIntegrationLock({ issue: '9', executionId: claim.executionId, targetBranch: 'dev', lockToken, cwd: repo });
    expect(reconciled).toContainEqual({ issue: '9', status: 'integrated' });
    expect(existsSync(claim.workspacePath)).toBe(false);
    expect((await lifecycleDoctor({ cwd: repo })).findings).toEqual([]);
  }, 20_000);

  it('blocks automatic pruning when Factory workspace content is dirty', async () => {
    const claim = await claimWorkspace({ issue: '10', cwd: repo, owner: 'external:test:400', base: 'dev' });
    writeFileSync(join(claim.workspacePath, 'uncommitted.txt'), 'retain me');
    for (const to of ['validating', 'ready', 'integrating', 'integrated', 'cleanup_pending'] as const) {
      await transitionWorkspace({ issue: '10', to, executionId: claim.executionId, fencingToken: claim.fencingToken, cwd: repo });
    }
    await expect(pruneWorkspace({ issue: '10', cwd: repo })).rejects.toThrow('uncommitted changes');
    expect(existsSync(join(claim.workspacePath, 'uncommitted.txt'))).toBe(true);
  });

  it('verifies Factory run context from the local row and transfers only a ready claim', async () => {
    const firstPath = join(repo, 'factory-first');
    git(repo, 'worktree', 'add', '-q', '-b', 'factory/first', firstPath, 'dev');
    const base = git(repo, 'rev-parse', 'dev');
    const first = await registerFactoryWorkspace({ issue: 88, runId: 'factory-run-one', repoRoot: repo, workspacePath: firstPath, baseCommit: base });
    const ctx = {
      FACTORY_MANAGED: '1', FACTORY_RUN_ID: first.executionId, FACTORY_ISSUE: first.issue,
      FACTORY_OWNER_ID: first.ownerId, FACTORY_FENCING_TOKEN: String(first.fencingToken), FACTORY_WORKSPACE: first.workspacePath,
    };
    expect(factoryContextForRun(repo, 88, 'factory-run-one')).toEqual(first);
    expect(await verifiedFactoryContext(ctx, firstPath)).toMatchObject({ managed: true });
    expect(JSON.stringify(await buildWorkspaceHookContext({ cwd: firstPath }, 'SessionStart', ctx)))
      .toContain('Verified Factory-managed execution');
    const phaseContext = await buildWorkspaceHookContext({ cwd: firstPath }, 'SessionStart', {
      FACTORY_MANAGED: '1', FACTORY_LIFECYCLE: '0',
    });
    expect(JSON.stringify(phaseContext)).toContain('without workspace lifecycle participation');
    expect(JSON.stringify(phaseContext)).not.toContain('Stop before editing');
    expect(JSON.stringify(await buildWorkspaceHookContext({ cwd: firstPath }, 'SessionStart', { FACTORY_MANAGED: '1' })))
      .toContain('Stop before editing');
    expect(await verifiedFactoryContext({ ...ctx, FACTORY_FENCING_TOKEN: String(first.fencingToken + 1) }, firstPath)).toMatchObject({ managed: false });
    const uncommitted = join(firstPath, 'unfinished.txt');
    writeFileSync(uncommitted, 'preserve it');
    await expect(handoffWorkspace({ executionId: first.executionId, fencingToken: first.fencingToken, cwd: repo }))
      .rejects.toThrow('uncommitted changes');
    rmSync(uncommitted);
    await handoffWorkspace({ executionId: first.executionId, fencingToken: first.fencingToken, cwd: repo });

    const nextPath = join(repo, 'factory-next');
    git(repo, 'worktree', 'add', '-q', '-b', 'factory/next', nextPath, 'dev');
    const next = await registerFactoryWorkspace({
      issue: 88, runId: 'factory-run-two', repoRoot: repo, workspacePath: nextPath,
      baseCommit: base, allowReadyTransfer: true,
    });
    expect(next.fencingToken).toBe(first.fencingToken + 1);
    expect(factoryContextForRun(repo, 88, 'factory-run-one')).toBeNull();
  }, 20_000);

  it('recovers a failed terminal Factory phase into a new lifecycle owner without deleting its worktree', async () => {
    const base = git(repo, 'rev-parse', 'dev');
    const failedPath = join(repo, 'factory-failed-run');
    const retryPath = join(repo, 'factory-retry-run');
    git(repo, 'worktree', 'add', '-q', '-b', 'factory/failed-run', failedPath, 'dev');
    git(repo, 'worktree', 'add', '-q', '-b', 'factory/retry-run', retryPath, 'dev');
    const failed = await registerFactoryWorkspace({ issue: 89, runId: 'factory-run-failed', repoRoot: repo, workspacePath: failedPath, baseCommit: base });
    writeFileSync(join(failedPath, 'preserved.txt'), 'keep this failed phase for inspection');
    git(failedPath, ...GIT_ID, 'add', 'preserved.txt');
    const retry = await registerFactoryWorkspace({
      issue: 89, runId: 'factory-run-retry', repoRoot: repo, workspacePath: retryPath,
      baseCommit: base, allowTerminalTransfer: true,
    });
    expect(retry.executionId).toBe('factory-run-retry');
    expect(retry.workspacePath).toBe(retryPath);
    expect((await lifecycleStatus({ cwd: repo, issue: '89' }))[0]?.state).toBe('working');
    expect(existsSync(join(failedPath, 'preserved.txt'))).toBe(true);
    expect((await lifecycleEvents({ cwd: repo, issue: '89' })).map((item) => item.type)).toContain('factory_terminal_run_recovered');
  }, 20_000);

  it('runs configured validation without a shell and records pass or failure', async () => {
    const claim = await claimWorkspace({ issue: '99', cwd: repo, owner: 'external:test:990', base: 'dev' });
    const configPath = join(claim.workspacePath, '.ai', 'cezar', 'workspace-lifecycle.json');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(claim.workspacePath, '.ai', 'cezar'), { recursive: true });
    const output: string[] = [];
    const errors: string[] = [];
    const io = { log: (line: string) => output.push(line), error: (line: string) => errors.push(line) };
    writeFileSync(configPath, JSON.stringify({ validation: [
      [process.execPath, '-e', 'process.exit(0)'],
      [process.execPath, '-e', 'process.exit(0)'],
    ] }));
    git(claim.workspacePath, ...GIT_ID, 'add', '.ai/cezar/workspace-lifecycle.json');
    git(claim.workspacePath, ...GIT_ID, 'commit', '-q', '-m', 'add test validation policy');
    const unfinished = join(claim.workspacePath, 'unfinished.txt');
    writeFileSync(unfinished, 'preserve this uncommitted change');
    expect(await runWorkspaceCommand(['validate', '--issue', '99'], { cwd: repo, io })).toBe(1);
    expect(errors.join('\n')).toContain('uncommitted changes');
    expect((await lifecycleStatus({ cwd: repo, issue: '99' }))[0]?.state).toBe('working');
    const { rmSync } = await import('node:fs');
    rmSync(unfinished);
    expect(await runWorkspaceCommand(['validate', '--issue', '99'], { cwd: repo, io })).toBe(0);
    expect(output.join('\n')).toContain('passed');
    expect((await lifecycleStatus({ cwd: repo, issue: '99' }))[0]?.state).toBe('ready');

    writeFileSync(configPath, JSON.stringify({ validation: [
      [process.execPath, '-e', 'process.exit(0)'],
      [process.execPath, '-e', 'process.exit(3)'],
    ] }));
    expect(await runWorkspaceCommand(['validate', '--issue', '99'], { cwd: repo, io })).toBe(1);
    expect(errors.join('\n')).toContain('Validation failed');
    expect((await lifecycleStatus({ cwd: repo, issue: '99' }))[0]?.state).toBe('working');
    expect(existsSync(join(claim.workspacePath, 'base.txt'))).toBe(true);
  }, 20_000);
});
