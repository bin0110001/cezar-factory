import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { versionedWorkflowSchema } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { registerProject, removeProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { ocrPlugin, OCR_PROVIDER_VERSION } from '../server/verification/checks/providers/ocr-adapter.ts';
import { FileFindingLedgerStore } from '../verification/finding-ledger.ts';

const exec = promisify(execFile);
const gitIdentity = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local'];
const passManifest = (exitCode: number) => [
  'verification:', '  version: 1', '  checks:', '    check:', '      runner: command',
  `      executable: ${JSON.stringify(process.execPath)}`,
  `      args: ${JSON.stringify(['-e', `process.exit(${exitCode})`])}`,
  '      cwd: .', '      timeoutSeconds: 5', '      optional: false', '  suites:', '    quick: [check]', '',
].join('\n');

describe('nested lifecycle pilot E2E', () => {
  let root: string;
  let projectId: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cezar-lifecycle-pilot-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_DISPATCH']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISPATCH = '1';
    mkdirSync(join(root, '.ai/factory'), { recursive: true });
    writeFileSync(join(root, '.ai/factory/factory.config.yaml'), passManifest(0));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await exec('git', ['add', '-A'], { cwd: root });
    await exec('git', [...gitIdentity, 'commit', '-q', '-m', 'pilot fixture'], { cwd: root });
    projectId = (await registerProject(root)).id;
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root, { projectId, semaphore: new WorkspaceSemaphore() });
  });

  afterEach(async () => {
    for (const run of store.listRuns()) if (!['done', 'failed', 'cancelled'].includes(run.status)) manager.cancel(run.id);
    const deadline = Date.now() + 10_000;
    while (store.listRuns().some((run) => manager.isActive(run.id))) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for lifecycle fixture runs to stop');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    manager.dispose();
    store.flush();
    await removeProject(projectId);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); }
    catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      console.warn(`[lifecycle-pilot-e2e.test] Windows kept a locked temporary directory for runner cleanup: ${root}`);
    }
  });

  const childrenOf = (parentId: string): RunRecord[] => store.listRuns().filter((run) => run.dispatch?.parentRunId === parentId);
  const waitFor = async (id: string, predicate: (run: RunRecord | undefined) => boolean, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(store.getRun(id))) {
      if (Date.now() >= deadline) throw new Error(`lifecycle fixture timed out waiting for ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const settleAgent = async (run: RunRecord, outcome: 'passed' | 'changes_required', result: string): Promise<void> => {
    await waitFor(run.id, (record) => record?.status === 'running' && record.steps.some((step) => Boolean(step.sessionId)));
    expect(manager.recordReport(run.id, { status: 'done', outcome, result, evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(true);
  };
  const contract = (id: string, nodes: unknown[], terminals: string[], transitions: unknown[], budget: Record<string, number> = {}) => versionedWorkflowSchema.parse({
    contract: 'cezar.workflow', schemaVersion: 1, id, version: '1.0.0', entry: 'ready', terminals,
    nodes, transitions, inputs: [], policyRefs: [], budget, capabilities: [],
    compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
  });

  it.skipIf(process.platform === 'win32')('keeps ready→implement→verify→review→repair→review in the same implementation session', async () => {
    const workflow = contract('pilot.lifecycle', [
      { id: 'ready', kind: 'wait', reason: 'Plan approved', waitFor: 'human', outcomes: ['passed'] },
      { id: 'implement', kind: 'agent', session: 'continue', dispatchKind: 'implement', prompt: 'mock:pause mock:done implement {{task}}', outcomes: ['passed'] },
      { id: 'verify', kind: 'verification', suite: 'quick', outcomes: ['passed', 'changes_required', 'unknown', 'interrupted', 'exhausted'], outputs: [{ name: 'verificationId', type: 'string' }, { name: 'status', type: 'string' }, { name: 'findings', type: 'array' }] },
      { id: 'review', kind: 'agent', session: 'new', dispatchKind: 'review', prompt: 'mock:pause mock:done independent review', outcomes: ['passed', 'changes_required'] },
      { id: 'repair', kind: 'agent', session: 'continue', dispatchKind: 'implement', prompt: 'mock:pause mock:done repair the findings', outcomes: ['passed'] },
      { id: 'review-again', kind: 'agent', session: 'new', dispatchKind: 'review', prompt: 'mock:pause mock:done review the repair', outcomes: ['passed'] },
    ], ['review-again'], [
      { from: 'ready', outcome: 'passed', to: 'implement', order: 0 },
      { from: 'implement', outcome: 'passed', to: 'verify', order: 0 },
      { from: 'verify', outcome: 'passed', to: 'review', order: 0 },
      { from: 'verify', outcome: 'changes_required', to: 'repair', order: 1 },
      { from: 'review', outcome: 'changes_required', to: 'repair', order: 0 },
      { from: 'review', outcome: 'passed', to: 'review-again', order: 1 },
      { from: 'repair', outcome: 'passed', to: 'review-again', order: 0 },
    ], { maxAttempts: 12 });
    const rootRun = manager.startVersionedRun(workflow, { task: 'pilot the same-session lifecycle', runner: 'claude' }, {});
    expect(store.getRun(rootRun.id)?.status).toBe('waiting');
    manager.dispose();
    manager = new RunManager(store, root, { projectId, semaphore: new WorkspaceSemaphore() });
    await manager.recover();
    expect(manager.resumeVersionedRun(rootRun.id, { kind: 'human' })).toEqual({ ok: true });

    await waitFor(rootRun.id, () => childrenOf(rootRun.id).length === 1);
    const implementation = childrenOf(rootRun.id)[0]!;
    await settleAgent(implementation, 'passed', 'Implementation complete.');
    await waitFor(rootRun.id, (run) => Boolean(run?.workflowExecution?.attempts.some((attempt) => attempt.node === 'verify' && attempt.status === 'done')));
    const verificationEvents = store.readEvents(implementation.id).filter((event) => event.type === 'verification-result');
    expect(verificationEvents).toHaveLength(1);
    expect(verificationEvents[0]).toMatchObject({ status: 'passed', suite: 'quick' });

    await waitFor(rootRun.id, () => childrenOf(rootRun.id).length === 2);
    const firstReview = childrenOf(rootRun.id).find((child) => child.id !== implementation.id)!;
    await settleAgent(firstReview, 'changes_required', 'One bounded repair is needed.');
    await waitFor(implementation.id, (run) => run?.status === 'running' && run.steps.some((step) => step.id.startsWith('continue-') && step.sessionId));
    const originalSession = store.getRun(implementation.id)?.steps.find((step) => step.sessionId)?.sessionId;
    const repairSession = store.getRun(implementation.id)?.steps.find((step) => step.id.startsWith('continue-') && step.sessionId)?.sessionId;
    expect(repairSession).toBe(originalSession);
    expect(manager.recordReport(implementation.id, { status: 'done', outcome: 'passed', result: 'Repair complete.', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(true);

    await waitFor(rootRun.id, () => childrenOf(rootRun.id).length === 3);
    const finalReview = childrenOf(rootRun.id).find((child) => child.id !== implementation.id && child.id !== firstReview.id)!;
    await settleAgent(finalReview, 'passed', 'Repair verified.');
    await waitFor(rootRun.id, (run) => run?.status === 'done');
    expect(childrenOf(rootRun.id)).toHaveLength(3);
    expect(store.getRun(rootRun.id)?.workflowExecution).toMatchObject({
      status: 'done', outcomes: { ready: 'passed', implement: 'passed', verify: 'passed', review: 'changes_required', repair: 'passed', 'review-again': 'passed' },
    });
    expect(new Set([originalSession, store.getRun(firstReview.id)?.steps.find((step) => step.sessionId)?.sessionId, store.getRun(finalReview.id)?.steps.find((step) => step.sessionId)?.sessionId]).size).toBe(3);
  }, 120_000);

  it.skipIf(process.platform === 'win32')('routes an OCR claim through typed verification, repairs in-session, and rechecks the final SHA', async () => {
    writeFileSync(join(root, '.ai/factory/factory.config.yaml'), [
      'verification:', '  version: 1', '  checks:', '    ocr-review:', '      runner: provider', '      providerId: ocr', '      timeoutSeconds: 60', '      optional: false',
      '      definition:', '        id: ocr-review', '        category: ai-audit',
      `        provider: { name: ocr, version: ${OCR_PROVIDER_VERSION}, digest: sha256:${'a'.repeat(64)} }`,
      '        scopes: [baseline-diff]', '        triggers: [manual]',
      '        policy: { mandatory: true, timeoutMs: 30000, onFailure: error, onFeedUnavailable: unknown, cache: { enabled: false } }',
      '  suites:', '    review: [ocr-review]', '',
    ].join('\n'));
    await exec('git', ['add', '.ai/factory/factory.config.yaml'], { cwd: root });
    await exec('git', [...gitIdentity, 'commit', '-q', '-m', 'configure typed OCR review fixture'], { cwd: root });
    manager.dispose();
    let reviewCount = 0;
    const digest = `sha256:${'c'.repeat(64)}`;
    manager = new RunManager(store, root, {
      projectId, semaphore: new WorkspaceSemaphore(),
      verificationProviders: {
        ocr: (context) => {
          if (!context.baseSha) throw new Error('typed OCR verification requires the recorded immutable base SHA');
          const makeManifest = () => ({ schema_version: 'ocr.run-manifest/v1', operation: 'review', run_id: `ocr-${reviewCount + 1}`, terminal_state: 'complete', input: { mode: 'range', resolved_base: context.baseSha, resolved_head: context.sourceSha }, coverage: { selected: [{ path: 'src/example.ts' }], completed: [{ path: 'src/example.ts' }], reused: [], failed: [], waived: [] } });
          return ocrPlugin({
            repoPath: '/worker/repo', fromSha: context.baseSha, toSha: context.sourceSha,
            gatewayUrl: 'http://litellm:4000', gatewayToken: 'fixture-token', modelAlias: 'reviewer',
            budget: { maxTokens: 100, concurrency: 1, timeoutMinutes: 1 }, policyDigest: digest,
            rulePath: '/worker/rules/ocr.json', ruleDigest: digest,
            readUsage: async (sessionId) => ({ tokens: 37, costUsd: 0.01, receiptId: `receipt-${sessionId}` }),
            exec: async (argv) => {
              if (argv[1] === 'version') return { exitCode: 0, stdout: `ocr ${OCR_PROVIDER_VERSION}` };
              if (argv.includes('--preview')) return { exitCode: 0, stdout: JSON.stringify({ manifest: makeManifest(), comments: [] }) };
              reviewCount++;
              return { exitCode: 0, stdout: JSON.stringify({ session_id: `ocr-session-${reviewCount}`, manifest: makeManifest(), summary: { total_tokens: 37 }, warnings: [], tool_calls: { failure: 0 }, comments: reviewCount === 1 ? [{ path: 'src/example.ts', start_line: 4, severity: 'medium', content: 'Guard the nullable value.', suggestion_code: 'if (value == null) return;' }] : [] }) };
            },
          });
        },
      },
    });
    const workflow = contract('pilot.ocr-repair', [
      { id: 'ready', kind: 'wait', reason: 'Plan approved', waitFor: 'human', outcomes: ['passed'] },
      { id: 'implement', kind: 'agent', session: 'continue', dispatchKind: 'implement', prompt: 'mock:pause mock:done implement OCR finding', outcomes: ['passed'] },
      { id: 'verify', kind: 'verification', suite: 'review', outcomes: ['passed', 'changes_required', 'unknown', 'interrupted', 'exhausted'], outputs: [{ name: 'findings', type: 'array' }] },
      { id: 'repair', kind: 'agent', session: 'continue', dispatchKind: 'implement', prompt: 'mock:pause mock:done repair the OCR finding in this session', outcomes: ['passed'] },
      { id: 'verify-final', kind: 'verification', suite: 'review', outcomes: ['passed', 'changes_required', 'unknown', 'interrupted', 'exhausted'] },
    ], ['verify-final'], [
      { from: 'ready', outcome: 'passed', to: 'implement', order: 0 },
      { from: 'implement', outcome: 'passed', to: 'verify', order: 0 },
      { from: 'verify', outcome: 'changes_required', to: 'repair', order: 0 },
      { from: 'repair', outcome: 'passed', to: 'verify-final', order: 0 },
    ], { maxAttempts: 8 });
    const rootRun = manager.startVersionedRun(workflow, { task: 'fix OCR review finding', runner: 'claude' }, {});
    expect(manager.resumeVersionedRun(rootRun.id, { kind: 'human' })).toEqual({ ok: true });
    await waitFor(rootRun.id, () => childrenOf(rootRun.id).length === 1);
    const implementation = childrenOf(rootRun.id)[0]!;
    await settleAgent(implementation, 'passed', 'Implementation complete.');
    await waitFor(rootRun.id, (run) => Boolean(run?.workflowExecution?.attempts.some((attempt) => attempt.node === 'verify' && attempt.status === 'done')));
    await waitFor(implementation.id, (run) => run?.status === 'running' && run.steps.some((step) => step.id.startsWith('continue-') && step.sessionId));
    const originalSession = store.getRun(implementation.id)?.steps.find((step) => step.sessionId)?.sessionId;
    const repairSession = store.getRun(implementation.id)?.steps.find((step) => step.id.startsWith('continue-') && step.sessionId)?.sessionId;
    expect(repairSession).toBe(originalSession);
    writeFileSync(join(implementation.worktreePath!, 'ocr-fix.txt'), 'nullable value guarded\n');
    await exec('git', ['add', 'ocr-fix.txt'], { cwd: implementation.worktreePath! });
    await exec('git', [...gitIdentity, 'commit', '-q', '-m', 'repair OCR finding'], { cwd: implementation.worktreePath! });
    expect(manager.recordReport(implementation.id, { status: 'done', outcome: 'passed', result: 'OCR finding repaired.', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(true);
    await waitFor(rootRun.id, (run) => run?.status === 'done');
    expect(reviewCount).toBe(2);
    expect(store.getRun(rootRun.id)?.workflowExecution?.outcomes).toMatchObject({ verify: 'changes_required', repair: 'passed', 'verify-final': 'passed' });
    const verificationEvents = store.readEvents(implementation.id).filter((event) => event.type === 'verification-result') as unknown as Array<{ commitSha: string; status: string; result: { checks: Array<{ diagnostics: Array<{ reviewerSessionId?: string }>; ocrReviewEvidence?: { status: string; baseSha: string; headSha: string; usageReceiptId?: string; findings: Array<{ path: string; line: number; claim: string }> } }> } }>;
    expect(verificationEvents).toHaveLength(2);
    expect(verificationEvents[0]!.status).toBe('failed');
    expect(verificationEvents[0]!.result.checks[0]!.diagnostics[0]).toMatchObject({ reviewerSessionId: 'ocr-session-1' });
    expect(verificationEvents[1]!.status).toBe('passed');
    expect(verificationEvents[1]!.commitSha).not.toBe(verificationEvents[0]!.commitSha);
    expect(verificationEvents[1]!.result.checks[0]!.ocrReviewEvidence).toMatchObject({
      status: 'complete', headSha: verificationEvents[1]!.commitSha, usageReceiptId: 'receipt-ocr-session-2', findings: [],
    });
    const ledger = FileFindingLedgerStore.open(join(root, '.ai/cezar'), projectId).snapshot();
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.occurrences).toHaveLength(1);
    expect(ledger.episodes[0]?.status).toBe('resolved');
  }, 120_000);

  it('persists a human wait across recovery and splits follow-up work into two children', async () => {
    const workflow = contract('pilot.split', [
      { id: 'ready', kind: 'wait', reason: 'Ready to split', waitFor: 'human', outcomes: ['passed'] },
      { id: 'split', kind: 'fork', children: ['left', 'right'], join: { mode: 'all' }, outcomes: ['passed', 'unknown'] },
      { id: 'left', kind: 'agent', session: 'new', prompt: 'mock:pause mock:done left child', outcomes: ['passed'] },
      { id: 'right', kind: 'agent', session: 'new', prompt: 'mock:pause mock:done right child', outcomes: ['passed'] },
    ], ['split', 'left', 'right'], [{ from: 'ready', outcome: 'passed', to: 'split', order: 0 }], { maxAttempts: 6 });
    const rootRun = manager.startVersionedRun(workflow, { task: 'split the planned work', runner: 'claude' }, {});
    expect(store.getRun(rootRun.id)?.status).toBe('waiting');
    manager.dispose();
    manager = new RunManager(store, root, { projectId, semaphore: new WorkspaceSemaphore() });
    await manager.recover();
    expect(manager.resumeVersionedRun(rootRun.id, { kind: 'human' })).toEqual({ ok: true });
    await waitFor(rootRun.id, () => childrenOf(rootRun.id).length === 2);
    const branches = childrenOf(rootRun.id);
    for (const [index, branch] of branches.entries()) await settleAgent(branch, 'passed', `Split child ${index} complete.`);
    await waitFor(rootRun.id, (run) => run?.status === 'done');
    expect(new Set(branches.map((branch) => branch.id)).size).toBe(2);
    expect(store.getRun(rootRun.id)?.workflowExecution).toMatchObject({ status: 'done', outcomes: { left: 'passed', right: 'passed', split: 'passed' } });
  }, 90_000);

  it.skipIf(process.platform === 'win32')('turns repeated real verifier failures into a typed exhausted result', async () => {
    writeFileSync(join(root, '.ai/factory/factory.config.yaml'), passManifest(1));
    await exec('git', ['add', '.ai/factory/factory.config.yaml'], { cwd: root });
    await exec('git', [...gitIdentity, 'commit', '-q', '-m', 'failing check fixture'], { cwd: root });
    const workflow = contract('pilot.exhausted', [
      { id: 'ready', kind: 'wait', reason: 'Ready', waitFor: 'human', outcomes: ['passed'] },
      { id: 'implement', kind: 'agent', session: 'continue', dispatchKind: 'implement', prompt: 'mock:pause mock:done implement failing check', outcomes: ['passed'] },
      { id: 'verify', kind: 'verification', suite: 'quick', retry: { maxAttempts: 2, on: ['changes_required'] }, outcomes: ['passed', 'changes_required', 'unknown', 'interrupted', 'exhausted'] },
    ], ['verify'], [
      { from: 'ready', outcome: 'passed', to: 'implement', order: 0 },
      { from: 'implement', outcome: 'passed', to: 'verify', order: 0 },
    ], { maxAttempts: 8 });
    const rootRun = manager.startVersionedRun(workflow, { task: 'exhaust repeated failing checks', runner: 'claude' }, {});
    expect(manager.resumeVersionedRun(rootRun.id, { kind: 'human' })).toEqual({ ok: true });
    await waitFor(rootRun.id, () => childrenOf(rootRun.id).length === 1);
    const implementation = childrenOf(rootRun.id)[0]!;
    await settleAgent(implementation, 'passed', 'Implementation complete.');
    await waitFor(rootRun.id, (run) => run?.status === 'failed');
    expect(store.getRun(rootRun.id)?.workflowExecution).toMatchObject({ status: 'failed', outcomes: { verify: 'exhausted' } });
    expect(store.getRun(rootRun.id)?.workflowExecution?.attempts.filter((attempt) => attempt.node === 'verify')).toHaveLength(2);
    expect(store.readEvents(implementation.id).filter((event) => event.type === 'verification-result')).toHaveLength(2);
  }, 90_000);
});
