import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  adoptWorkspace, approveHindsightLesson, claimWorkspace, drainLifecycleOutbox, heartbeatWorkspace, lifecycleDoctor, lifecycleEvents, lifecycleOutbox, lifecycleStatus,
  recordIntegrationValidationFailure, recordWorkspacePreflight, resumeBlockedWorkspace, retryLifecycleOutbox, renewReadyWorkspaceLease, finalizeIntegratedWorkspace,
  acquireIntegrationLock, completeIntegration, handoffWorkspace, pruneWorkspace, recoverWorkspace,
  releaseIntegrationLock, renewIntegrationLock, transitionWorkspace, verifiedFactoryContext, workspaceOverlaps,
  type LifecycleState,
} from './lifecycle.ts';

const execFileAsync = promisify(execFile);
const USAGE = `cez workspace <command>

  context                              verify Factory ownership for this run
  claim --issue <id> [--base <branch>] create or resume an isolated issue workspace
  adopt --issue <id>                   register the current Git worktree without changing it
  preflight --issue <id>               compare the workspace branch with its integration target
  validate --issue <id>                run configured checks and mark work ready on success
  handoff --run <id> --fence <n>       mark a completed Factory coding phase ready for integration
  integrate --issue <id> --pr <id>     verify a merged PR, test its merge commit, then finalize
  reconcile                            retry ready PR integration and durable GitHub status updates
  heartbeat --issue <id> --run <id> --fence <n> renew a verified execution lease
  status [--issue <id>]                show current local lifecycle records
  list                                 list current local lifecycle records
  inspect --issue <id>                 inspect one issue's local lifecycle record
  overlaps                             show changed paths shared by active workspaces (advisory)
  hook-context --event <name>          supply verified context to a native agent lifecycle hook
  doctor                               reconcile registry records with Git worktrees
  outbox [--drain] [--retry <event-id> --destination <langfuse|hindsight>] [--approve-hindsight <event-id>] [--limit <n>] inspect or manage telemetry
  recover --issue <id> [--force]       recover expired ownership with an audit event
  resume --issue <id>                  resume a blocked lifecycle under its current owner
  prune --issue <id>                   remove only a clean Factory-created integrated worktree

Validation is configured in workspace-lifecycle.json as one argv array or an ordered
array of argv arrays. Every command runs directly without a shell.
`;

interface Io { log(line: string): void; error(line: string): void }
const defaultIo: Io = { log: (line) => console.log(line), error: (line) => console.error(line) };
function validationPlan(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('validation must contain at least one argv command.');
  const commands = typeof value[0] === 'string' ? [value] : value;
  if (commands.some((command) => !Array.isArray(command) || command.length === 0 ||
      command.some((part) => typeof part !== 'string' || !part.trim()))) {
    throw new Error('validation must be an argv array or an ordered array of argv arrays.');
  }
  return commands as string[][];
}

async function readPolicy(root: string): Promise<{ validation: string[][]; targetBranch?: unknown }> {
  const candidates = [
    join(root, '.ai', 'cezar', 'workspace-lifecycle.json'),
    join(root, '.cezar', 'workspace-lifecycle.json'),
    join(root, 'workspace-lifecycle.json'),
  ];
  let lastError: unknown;
  for (const path of candidates) {
    try {
      const config = JSON.parse(await readFile(path, 'utf8')) as { validation?: unknown; targetBranch?: unknown };
      return { validation: validationPlan(config.validation), targetBranch: config.targetBranch };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No workspace-lifecycle.json policy found at the repository root or supported Cezar config paths.');
}

/** Load and run merged-tree checks as one unit so policy/setup errors count as validation failures. */
export async function runPostMergeValidation(root: string): Promise<Array<{ command: string[]; stdout: string; stderr: string }>> {
  const policy = await readPolicy(root);
  const results: Array<{ command: string[]; stdout: string; stderr: string }> = [];
  for (const command of policy.validation) {
    const [file, ...args] = command;
    const result = await execFileAsync(file!, args, {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60 * 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    results.push({ command, stdout: result.stdout, stderr: result.stderr });
  }
  return results;
}

async function readIntegrationTarget(root: string): Promise<string> {
  const candidates = [
    join(root, '.ai', 'cezar', 'workspace-lifecycle.json'),
    join(root, '.cezar', 'workspace-lifecycle.json'),
    join(root, 'workspace-lifecycle.json'),
  ];
  for (const path of candidates) {
    try {
      const config = JSON.parse(await readFile(path, 'utf8')) as { targetBranch?: unknown };
      const target = typeof config.targetBranch === 'string' ? config.targetBranch.trim() : '';
      return target || 'dev';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`Cannot read workspace lifecycle policy ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return 'dev';
}

async function preflight(issue: string, cwd: string): Promise<unknown> {
  const records = await lifecycleStatus({ cwd, issue });
  const record = records[0];
  if (!record) throw new Error(`Issue ${issue} has no active lifecycle workspace.`);
  if (!['working', 'validating', 'ready', 'blocked', 'recoverable'].includes(record.state)) {
    throw new Error(`Issue ${issue} cannot be preflighted from ${record.state}.`);
  }
  const targetBranch = await readIntegrationTarget(cwd);
  await execFileAsync('git', ['check-ref-format', `refs/heads/${targetBranch}`], { cwd, encoding: 'utf8', windowsHide: true });
  await execFileAsync('git', ['check-ref-format', `refs/heads/${record.branch}`], { cwd, encoding: 'utf8', windowsHide: true });
  const remoteTarget = `refs/remotes/origin/${targetBranch}`;
  const localTarget = `refs/heads/${targetBranch}`;
  const targetRef = await execFileAsync('git', ['rev-parse', '--verify', `${remoteTarget}^{commit}`], {
    cwd, encoding: 'utf8', windowsHide: true,
  }).then(() => remoteTarget, () => localTarget);
  const targetCommit = (await execFileAsync('git', ['rev-parse', '--verify', `${targetRef}^{commit}`], {
    cwd, encoding: 'utf8', windowsHide: true,
  })).stdout.trim();
  const branchCommit = (await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${record.branch}^{commit}`], {
    cwd, encoding: 'utf8', windowsHide: true,
  })).stdout.trim();
  let mergeTree: string;
  let clean = true;
  try {
    mergeTree = (await execFileAsync('git', ['merge-tree', '--write-tree', targetCommit, branchCommit], {
      cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    })).stdout;
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    if (result.code !== 1) throw new Error(`Git merge preflight failed: ${result.stderr || result.message}`);
    mergeTree = result.stdout ?? '';
    clean = false;
  }
  const conflictLines = mergeTree.split(/\r?\n/).filter((line) => /^CONFLICT /.test(line));
  const conflictingPaths = [...new Set(conflictLines.flatMap((line) => {
    const match = line.match(/(?:Merge conflict in|File )\s*([^;]+?)(?:\s+is a directory|$)/);
    return match?.[1] ? [match[1].trim()] : [];
  }))].sort();
  await recordWorkspacePreflight({
    issue: record.issue,
    executionId: record.executionId,
    fencingToken: record.fencingToken,
    targetBranch,
    targetRef,
    targetCommit,
    branchCommit,
    conflictingPaths,
    diagnostics: clean ? undefined : mergeTree,
    cwd,
  });
  const overlaps = (await workspaceOverlaps({ cwd })).filter((entry) => entry.issues.includes(record.issue));
  return {
    issue: record.issue,
    status: clean ? 'clean' : 'conflicts',
    targetBranch,
    targetRef,
    targetCommit,
    branch: record.branch,
    branchCommit,
    conflictingPaths,
    diagnostics: clean ? undefined : mergeTree,
    overlaps,
    repairContext: clean ? undefined : {
      issue: record.issue, targetBranch, targetRef, targetCommit, branch: record.branch, branchCommit,
      conflictingPaths, diagnostics: mergeTree,
    },
  };
}

function flags(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === 'force' || name === 'json' || name === 'drain') result[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
      result[name] = value;
    }
  }
  return result;
}

function required(value: string | boolean | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required.`);
  return value;
}

function integerFlag(value: string | boolean | undefined, name: string, min = 1): number {
  const number = Number(required(value, name));
  if (!Number.isSafeInteger(number) || number < min) throw new Error(`--${name} must be an integer of at least ${min}.`);
  return number;
}

function outboxDestination(value: string | boolean | undefined): 'langfuse' | 'hindsight' {
  const destination = required(value, 'destination');
  if (destination !== 'langfuse' && destination !== 'hindsight') throw new Error('--destination must be langfuse or hindsight.');
  return destination;
}

function print(value: unknown, json: boolean, io: Io): void {
  if (json) io.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value)) io.log(value.length ? value.map((item) => format(item)).join('\n') : 'No lifecycle records.');
  else if (value && typeof value === 'object' && 'findings' in value) {
    const report = value as { repoRoot: string; registered: unknown[]; findings: string[] };
    io.log(`Repository: ${report.repoRoot}\nRegistered workspaces: ${report.registered.length}\n` + (report.findings.length ? report.findings.map((x) => `- ${x}`).join('\n') : 'No findings.'));
  } else io.log(format(value));
}

function format(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const row = value as Record<string, unknown>;
  if ('issue' in row && 'workspacePath' in row) {
    return `#${row.issue}  ${row.state}  ${row.branch}\n  path: ${row.workspacePath}\n  owner: ${row.ownerId}  fence: ${row.fencingToken}  lease: ${row.leaseExpiresAt}`;
  }
  return JSON.stringify(value, null, 2);
}

export async function buildWorkspaceHookContext(input: { cwd?: string }, eventName: string, env = process.env): Promise<unknown> {
  const cwd = input.cwd ?? process.cwd();
  const context = await verifiedFactoryContext(env, cwd);
  let message: string;
  if (context.managed && context.execution) {
    message = `Verified Factory-managed execution for issue #${context.execution.issue} (run ${context.execution.executionId}) at ${context.execution.workspacePath}. Factory owns claim, validation, handoff, recovery, and cleanup; external workspace lifecycle actions are inert for this run.`;
  } else if (env.FACTORY_MANAGED === '1' && env.FACTORY_LIFECYCLE === '0') {
    message = 'Verified Cezar Factory workflow phase without workspace lifecycle participation. Continue the assigned Factory phase; do not claim, adopt, or clean up a workspace from this phase.';
  } else if (env.FACTORY_MANAGED === '1') {
    message = `Factory context verification failed: ${context.reason} Stop before editing. Inspect cez workspace status and doctor, then have the operator recover the stale Factory run; do not make an external claim.`;
  } else {
    const normalizePath = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    const record = await lifecycleStatus({ cwd }).then((records) => records.find((row) => normalizePath(row.workspacePath) === normalizePath(cwd))).catch(() => undefined);
    if (record && eventName === 'Stop' && ['working', 'validating'].includes(record.state)) {
      message = `External workspace for issue #${record.issue} is still ${record.state}. Do not report coding complete; finish work, then run cez workspace validate --issue ${record.issue}.`;
    } else if (record && eventName === 'Stop' && record.state === 'ready') {
      message = `External workspace for issue #${record.issue} is ready and awaiting verified integration. Do not report the issue integrated until GitHub confirms the merged PR and post-integration validation passes.`;
    } else {
      message = 'External coding session: before editing, use the factory-workspace skill and cez workspace status to inspect ownership. Adopt the intended developer worktree or claim the supplied issue; do not invent an issue or override another owner.';
    }
  }
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: message } };
}

async function hookContext(args: Record<string, string | boolean>, cwd: string): Promise<unknown> {
  const raw = await new Promise<string>((resolveInput, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { input += chunk; });
    process.stdin.on('end', () => resolveInput(input));
    process.stdin.on('error', reject);
  });
  let input: { cwd?: string } = { cwd };
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as { cwd?: unknown };
      if (typeof parsed.cwd === 'string') input = { cwd: parsed.cwd };
    } catch { /* hooks without an input payload use the process working directory */ }
  }
  return buildWorkspaceHookContext(input, required(args.event, 'event'));
}

export async function validateWorkspace(issue: string, cwd: string): Promise<unknown> {
  const rows = await lifecycleStatus({ cwd, issue });
  const record = rows[0];
  if (!record) throw new Error(`Issue ${issue} has no active workspace.`);
  await transitionWorkspace({ issue, to: 'validating', cwd, executionId: record.executionId, fencingToken: record.fencingToken });
  let commands: string[][];
  try {
    commands = (await readPolicy(record.workspacePath)).validation;
  } catch (error) {
    await transitionWorkspace({ issue, to: 'working', cwd, executionId: record.executionId, fencingToken: record.fencingToken });
    throw new Error(`Cannot run lifecycle validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const results = [];
    for (const command of commands) {
      const [file, ...args] = command;
      const result = await execFileAsync(file!, args, { cwd: record.workspacePath, encoding: 'utf8', windowsHide: true, timeout: 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
      results.push({ command, stdout: result.stdout, stderr: result.stderr });
    }
    const dirty = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: record.workspacePath, encoding: 'utf8', windowsHide: true,
    }).then((result) => result.stdout.trim());
    if (dirty) throw new Error(`Validation passed but workspace has uncommitted changes; issue remains working.\n${dirty}`);
    const ready = await transitionWorkspace({ issue, to: 'ready', cwd, executionId: record.executionId, fencingToken: record.fencingToken });
    return { result: 'passed', commands: results, execution: ready };
  } catch (error) {
    await transitionWorkspace({ issue, to: 'working', cwd, executionId: record.executionId, fencingToken: record.fencingToken }).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Validation failed; issue remains working. ${detail}`);
  }
}

async function integrate(issue: string, pullRequest: string, cwd: string): Promise<unknown> {
  const rows = await lifecycleStatus({ cwd, issue });
  let record = rows[0];
  if (!record) throw new Error(`Issue ${issue} has no active lifecycle workspace.`);
  if (record.state !== 'ready') throw new Error(`Issue ${issue} must be ready before integration (current state: ${record.state}).`);
  record = await renewReadyWorkspaceLease({ issue, executionId: record.executionId, fencingToken: record.fencingToken, cwd });
  const branchCheck = await execFileAsync('git', ['check-ref-format', `refs/heads/${record.branch}`], { cwd: record.workspacePath, encoding: 'utf8', windowsHide: true }).catch(() => null);
  if (!branchCheck) throw new Error(`Recorded branch is not a safe Git ref: ${record.branch}`);
  const rootPolicy = await readPolicy(cwd);
  const targetBranch = typeof rootPolicy.targetBranch === 'string' && rootPolicy.targetBranch.trim() ? rootPolicy.targetBranch.trim() : 'dev';
  await execFileAsync('git', ['check-ref-format', `refs/heads/${targetBranch}`], { cwd, encoding: 'utf8', windowsHide: true });
  const gh = await execFileAsync('gh', ['pr', 'view', pullRequest, '--json', 'state,mergedAt,mergeCommit,headRefOid,baseRefName'], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  const pr = JSON.parse(gh.stdout) as {
    state?: string; mergedAt?: string; headRefOid?: string; baseRefName?: string; mergeCommit?: { oid?: string };
  };
  if (pr.state !== 'MERGED' || !pr.mergedAt || !pr.mergeCommit?.oid) throw new Error('GitHub does not report this PR as merged; the lifecycle remains ready.');
  if (pr.baseRefName !== targetBranch) throw new Error(`PR targets ${pr.baseRefName ?? 'an unknown branch'}, expected ${targetBranch}.`);
  const head = (await execFileAsync('git', ['rev-parse', `refs/heads/${record.branch}`], { cwd, encoding: 'utf8', windowsHide: true })).stdout.trim();
  if (pr.headRefOid !== head) throw new Error(`PR head ${pr.headRefOid ?? '(missing)'} does not match the registered workspace head ${head}.`);
  const ref = `refs/remotes/origin/${targetBranch}`;
  await execFileAsync('git', ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', `+refs/heads/${targetBranch}:${ref}`], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  await execFileAsync('git', ['merge-base', '--is-ancestor', pr.mergeCommit.oid, ref], { cwd, encoding: 'utf8', windowsHide: true });

  const token = record.fencingToken;
  const lockToken = await acquireIntegrationLock({ issue, executionId: record.executionId, fencingToken: token, targetBranch, cwd });
  let tempRoot: string | undefined;
  let tempWorktree: string | undefined;
  let keepDiagnostics = false;
  let diagnosticMessage: string | undefined;
  let validationPassed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    tempRoot = mkdtempSync(join(tmpdir(), 'cez-lifecycle-verify-'));
    const verificationWorktree = join(tempRoot, 'merged-tree');
    tempWorktree = verificationWorktree;
    heartbeat = setInterval(() => {
      void heartbeatWorkspace({ issue, executionId: record.executionId, fencingToken: token, cwd }).catch(() => undefined);
      void renewIntegrationLock({ issue, executionId: record.executionId, fencingToken: token, targetBranch, lockToken, cwd }).catch(() => undefined);
    }, 5 * 60_000);
    heartbeat.unref?.();
    await transitionWorkspace({ issue, to: 'integrating', cwd, executionId: record.executionId, fencingToken: token });
    await execFileAsync('git', ['worktree', 'add', '--detach', verificationWorktree, pr.mergeCommit.oid], { cwd, encoding: 'utf8', windowsHide: true });
    try {
      const results = await runPostMergeValidation(verificationWorktree);
      validationPassed = true;
      const integrated = await completeIntegration({
        issue, executionId: record.executionId, fencingToken: token, targetBranch,
        pullRequest, headCommit: head, integratedCommit: pr.mergeCommit.oid, integrationLockToken: lockToken, cwd,
      });
      // The GitHub issue update is intentionally after post-merge validation.
      // If GitHub is offline, the durable `integrated` row remains for retry and
      // the workspace is retained until that remote bookkeeping succeeds.
      await syncIntegratedIssueState(issue, cwd);
      const cleanup = await finalizeIntegratedWorkspace({ issue, cwd, executionId: record.executionId, fencingToken: token });
      const pruned = await pruneWorkspace({ issue, cwd });
      return { status: 'integrated', targetBranch, pullRequest, headCommit: head, integratedCommit: pr.mergeCommit.oid,
        validation: { commands: results }, cleanup: pruned,
        execution: cleanup ?? integrated };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let state: 'ready' | 'blocked' = 'ready';
      let attempts: number | undefined;
      if (!validationPassed) {
        attempts = await recordIntegrationValidationFailure({ issue, executionId: record.executionId,
          fencingToken: token, detail, cwd }).catch(() => undefined);
        if (attempts === undefined || attempts >= 3) state = 'blocked';
      }
      await transitionWorkspace({ issue, to: state, cwd, executionId: record.executionId, fencingToken: token }).catch(() => undefined);
      const retryMessage = attempts === undefined ? '' : ` Validation attempt ${attempts}/3${state === 'blocked' ? '; automatic retries stopped and the workspace is blocked for operator repair.' : '.'}`;
      throw new Error(`Post-integration validation or finalization failed; workspace retained.${retryMessage} ${detail}`);
    }
  } catch (error) {
    const current = await lifecycleStatus({ cwd, issue }).then((items) => items[0]).catch(() => undefined);
    if (current?.state === 'integrating') {
      await transitionWorkspace({ issue, to: 'ready', cwd, executionId: record.executionId, fencingToken: token }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (tempWorktree && existsSync(tempWorktree)) {
      const dirty = await execFileAsync('git', ['status', '--porcelain'], { cwd: tempWorktree, encoding: 'utf8', windowsHide: true }).then((result) => result.stdout.trim(), () => 'unknown');
      if (!dirty) {
        await execFileAsync('git', ['worktree', 'remove', tempWorktree], { cwd, encoding: 'utf8', windowsHide: true }).catch(() => undefined);
        await execFileAsync('git', ['worktree', 'prune'], { cwd, encoding: 'utf8', windowsHide: true }).catch(() => undefined);
        if (existsSync(tempWorktree)) keepDiagnostics = true;
      } else keepDiagnostics = true;
    }
    if (!keepDiagnostics && (!tempWorktree || !existsSync(tempWorktree))) {
      const { rm } = await import('node:fs/promises');
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    } else if (keepDiagnostics) {
      diagnosticMessage = `Validation worktree with diagnostic changes was preserved at ${tempWorktree}`;
    }
    await releaseIntegrationLock({ issue, executionId: record.executionId, targetBranch, lockToken, cwd });
    if (diagnosticMessage) console.warn(diagnosticMessage);
  }
}

interface MergedPullRequest {
  url: string;
  headRefOid: string;
  mergeCommit: { oid: string };
}

const FACTORY_STATE_LABELS = [
  'factory:new', 'factory:needs-plan', 'factory:needs-help', 'factory:ready', 'factory:working',
  'factory:review', 'factory:changes-requested', 'factory:human-review', 'factory:blocked',
  'factory:done', 'factory:investigate',
];

export function integratedIssueLabelEdits(labels: string[]): { add: string[]; remove: string[] } {
  const present = new Set(labels);
  return {
    add: present.has('factory:done') ? [] : ['factory:done'],
    remove: FACTORY_STATE_LABELS.filter((label) => label !== 'factory:done' && present.has(label)),
  };
}

async function syncIntegratedIssueState(issue: string, cwd: string): Promise<void> {
  const response = await execFileAsync('gh', ['issue', 'view', issue, '--json', 'labels'], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  const data = JSON.parse(response.stdout) as { labels?: Array<{ name?: string }> };
  const labels = (data.labels ?? []).flatMap((label) => typeof label.name === 'string' ? [label.name] : []);
  const edits = integratedIssueLabelEdits(labels);
  if (!edits.add.length && !edits.remove.length) return;
  const args = ['issue', 'edit', issue];
  if (edits.add.length) args.push('--add-label', edits.add.join(','));
  if (edits.remove.length) args.push('--remove-label', edits.remove.join(','));
  await execFileAsync('gh', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}

async function findMergedPullRequest(record: Awaited<ReturnType<typeof lifecycleStatus>>[number], targetBranch: string, cwd: string): Promise<MergedPullRequest | null> {
  const headCommit = (await execFileAsync('git', ['rev-parse', `refs/heads/${record.branch}`], {
    cwd, encoding: 'utf8', windowsHide: true,
  })).stdout.trim();
  const response = await execFileAsync('gh', ['pr', 'list', '--state', 'merged', '--head', record.branch,
    '--base', targetBranch, '--json', 'url,headRefOid,mergeCommit'], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  const pullRequests = JSON.parse(response.stdout) as Array<Partial<MergedPullRequest>>;
  const matching = pullRequests.filter((pr): pr is MergedPullRequest =>
    typeof pr.url === 'string' && pr.headRefOid === headCommit && typeof pr.mergeCommit?.oid === 'string');
  if (matching.length > 1) throw new Error(`Multiple merged PRs match ready issue #${record.issue} at ${headCommit}.`);
  return matching[0] ?? null;
}

/** Complete merged PRs for ready local claims without requiring a human to rerun the CLI.
 * GitHub/CLI failures are per-item and leave the claim ready for a later sweep. */
export async function reconcileReadyWorkspaceIntegrations(options: {
  cwd?: string;
  discover?: typeof findMergedPullRequest;
  integratePr?: typeof integrate;
  syncIssueState?: typeof syncIntegratedIssueState;
} = {}): Promise<Array<{ issue: string; status: 'integrated' | 'pending' | 'failed'; detail?: string }>> {
  const cwd = options.cwd ?? process.cwd();
  const pending = (await lifecycleStatus({ cwd })).filter((record) => ['ready', 'integrated'].includes(record.state));
  if (!pending.length) return [];
  const targetBranch = await readIntegrationTarget(cwd);
  const discover = options.discover ?? findMergedPullRequest;
  const integratePr = options.integratePr ?? integrate;
  const syncIssueState = options.syncIssueState ?? syncIntegratedIssueState;
  const results: Array<{ issue: string; status: 'integrated' | 'pending' | 'failed'; detail?: string }> = [];
  for (const record of pending) {
    try {
      if (record.state === 'integrated') {
        // Keep the workspace as a durable retry record until GitHub status is updated.
        await syncIssueState(record.issue, cwd);
        await finalizeIntegratedWorkspace({ issue: record.issue, cwd,
          executionId: record.executionId, fencingToken: record.fencingToken });
        await pruneWorkspace({ issue: record.issue, cwd });
        results.push({ issue: record.issue, status: 'integrated' });
        continue;
      }
      await renewReadyWorkspaceLease({ issue: record.issue, executionId: record.executionId,
        fencingToken: record.fencingToken, cwd });
      const pullRequest = await discover(record, targetBranch, cwd);
      if (!pullRequest) {
        results.push({ issue: record.issue, status: 'pending' });
        continue;
      }
      await integratePr(record.issue, pullRequest.url, cwd);
      results.push({ issue: record.issue, status: 'integrated' });
    } catch (error) {
      results.push({ issue: record.issue, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export async function runWorkspaceCommand(args: string[], opts: { cwd?: string; io?: Io } = {}): Promise<number> {
  const io = opts.io ?? defaultIo;
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  try {
    const parsed = flags(rest);
    const json = parsed.json === true;
    const cwd = typeof parsed.repo === 'string' ? parsed.repo : opts.cwd ?? process.cwd();
    let result: unknown;
    switch (command) {
      case 'hook-context': result = await hookContext(parsed, cwd); break;
      case 'context': result = await verifiedFactoryContext(process.env, cwd); break;
      case 'claim': result = await claimWorkspace({ issue: required(parsed.issue, 'issue'), cwd, base: typeof parsed.base === 'string' ? parsed.base : undefined, owner: typeof parsed.owner === 'string' ? parsed.owner : undefined, minutes: parsed.minutes === undefined ? undefined : integerFlag(parsed.minutes, 'minutes') }); break;
      case 'adopt': result = await adoptWorkspace({ issue: required(parsed.issue, 'issue'), cwd, owner: typeof parsed.owner === 'string' ? parsed.owner : undefined, minutes: parsed.minutes === undefined ? undefined : integerFlag(parsed.minutes, 'minutes') }); break;
      case 'preflight': result = await preflight(required(parsed.issue, 'issue'), cwd); break;
      case 'validate': result = await validateWorkspace(required(parsed.issue, 'issue'), cwd); break;
      case 'handoff': result = await handoffWorkspace({ executionId: required(parsed.run, 'run'), fencingToken: integerFlag(parsed.fence, 'fence'), cwd }); break;
      case 'integrate': result = await integrate(required(parsed.issue, 'issue'), required(parsed.pr, 'pr'), cwd); break;
      case 'reconcile': result = await reconcileReadyWorkspaceIntegrations({ cwd }); break;
      case 'heartbeat': result = await heartbeatWorkspace({ issue: required(parsed.issue, 'issue'), executionId: required(parsed.run, 'run'), fencingToken: integerFlag(parsed.fence, 'fence'), cwd }); break;
      case 'status':
      case 'list': result = await lifecycleStatus({ cwd, issue: typeof parsed.issue === 'string' ? parsed.issue : undefined }); break;
      case 'inspect': {
        const issue = required(parsed.issue, 'issue');
        result = { records: await lifecycleStatus({ cwd, issue }), events: await lifecycleEvents({ cwd, issue }) };
        break;
      }
      case 'overlaps': result = await workspaceOverlaps({ cwd }); break;
      case 'doctor': result = await lifecycleDoctor({ cwd }); break;
      case 'outbox': result = typeof parsed['approve-hindsight'] === 'string'
        ? await approveHindsightLesson({ eventId: parsed['approve-hindsight'], cwd })
        : typeof parsed.retry === 'string'
          ? await retryLifecycleOutbox({ eventId: parsed.retry, destination: outboxDestination(parsed.destination), cwd })
        : parsed.drain === true
          ? await drainLifecycleOutbox({ cwd, limit: parsed.limit === undefined ? undefined : integerFlag(parsed.limit, 'limit') })
          : await lifecycleOutbox({ cwd, limit: parsed.limit === undefined ? undefined : integerFlag(parsed.limit, 'limit') }); break;
      case 'recover': result = await recoverWorkspace({ issue: required(parsed.issue, 'issue'), cwd, force: parsed.force === true, owner: typeof parsed.owner === 'string' ? parsed.owner : undefined }); break;
      case 'resume': result = await resumeBlockedWorkspace({ issue: required(parsed.issue, 'issue'), cwd }); break;
      case 'prune': result = await pruneWorkspace({ issue: required(parsed.issue, 'issue'), cwd }); break;
      default: throw new Error(`Unknown workspace command "${command}".\n\n${USAGE}`);
    }
    print(result, json, io);
    if (command === 'preflight' && result && typeof result === 'object' && 'status' in result && result.status === 'conflicts') return 2;
    return 0;
  } catch (error) {
    io.error(`cez workspace: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
