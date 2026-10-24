import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  VERIFICATION_LIMITS, verificationCheckRunSchema, verificationManifestSchema, verificationRunSchema,
  type VerificationCheckRun, type VerificationManifest, type VerificationRun,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { selectVerificationChecks, type SelectionRequest, type VerificationSelection } from './selection.ts';

const execFileAsync = promisify(execFile);
const MANIFEST_PATH = '.ai/factory/factory.config.yaml';
const ARTIFACT_ROOT = '.factory/artifacts/verification';
const resourceTails = new Map<string, Promise<void>>();

export interface VerificationExecutionInput {
  worktreePath: string;
  cezarRunId: string;
  projectId: string;
  suite: string;
  availableCapabilities?: string[];
  adapter?: VerificationAdapter;
  selection?: SelectionRequest;
  cancelled?: () => boolean;
  onOutput?: (text: string) => void;
}

export interface VerificationAdapterContext {
  root: string;
  checkId: string;
  check: VerificationManifest['checks'][string];
  cwd: string;
  cancelled: () => boolean;
}

/** Lifecycle hooks for project-owned adapters layered over the safe command runner. */
export interface VerificationAdapter {
  discover?(root: string): Promise<string[]>;
  preflight?(context: VerificationAdapterContext): Promise<{ status?: 'skipped' | 'unknown' | 'infrastructure-error'; message?: string }>;
  execute?(context: VerificationAdapterContext, runCommand: () => Promise<{ status: VerificationCheckRun['status']; code: number | null; output: string; truncated: boolean; durationMs: number }>): ReturnType<typeof runCommand>;
  collect?(context: VerificationAdapterContext, result: VerificationCheckRun): Promise<VerificationCheckRun>;
  cleanup?(context: VerificationAdapterContext): Promise<void>;
}

export interface VerificationExecutionResult {
  run: VerificationRun;
  artifactPath: string;
  output: string;
  selection: VerificationSelection;
}

async function withResources<T>(keys: string[], cancelled: () => boolean, fn: () => Promise<T>): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const key of [...new Set(keys)].sort()) {
      const previous = resourceTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
      const tail = previous.then(() => current);
      resourceTails.set(key, tail);
      while (!await Promise.race([previous.then(() => true), new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 50))])) {
        if (cancelled()) { release(); throw new Error('verification cancelled while waiting for resources'); }
      }
      if (cancelled()) { release(); throw new Error('verification cancelled while waiting for resources'); }
      releases.push(release);
    }
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
    for (const key of keys) {
      const tail = resourceTails.get(key);
      if (tail) void tail.then(() => { if (resourceTails.get(key) === tail) resourceTails.delete(key); });
    }
  }
}

function semanticExit(status: VerificationRun['status']): number {
  return status === 'passed' ? 0 : status === 'failed' ? 1 : status === 'infrastructure-error' ? 3 : status === 'cancelled' ? 4 : 2;
}

function aggregate(checks: VerificationCheckRun[]): VerificationRun['status'] {
  if (checks.some((c) => c.status === 'cancelled')) return 'cancelled';
  if (checks.some((c) => c.status === 'infrastructure-error')) return 'infrastructure-error';
  if (checks.some((c) => c.status === 'failed')) return 'failed';
  if (checks.some((c) => c.status === 'unknown')) return 'unknown';
  if (checks.length > 0 && checks.every((c) => c.status === 'not-selected')) return 'not-selected';
  if (checks.some((c) => c.status === 'no-tests') || checks.length === 0) return 'no-tests';
  if (checks.some((c) => c.required && c.status === 'skipped')) return 'skipped';
  return 'passed';
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function sanitizeOutput(text: string, root: string, secretValues: readonly string[]): string {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutRoot = text.replace(new RegExp(escaped, 'gi'), '.').replaceAll(root.replaceAll('\\', '/'), '.');
  return redactSecrets(withoutRoot, secretValues);
}

/** Apply the same root and secret redaction before verification details enter prompts or ledgers. */
export function sanitizeVerificationText(text: string, root: string): string {
  return sanitizeOutput(text, root, collectSecretValues());
}

async function writeResult(root: string, id: string, run: VerificationRun): Promise<string> {
  const base = join(root, ARTIFACT_ROOT);
  await mkdir(base, { recursive: true });
  const realBase = await realpath(base);
  if (!inside(root, realBase)) throw new Error('verification artifact directory escapes worktree');
  const runDir = join(realBase, id);
  await mkdir(runDir, { recursive: true });
  const realRunDir = await realpath(runDir);
  if (!inside(realBase, realRunDir)) throw new Error('verification run artifact directory escapes its root');
  const artifactPath = join(realRunDir, 'result.json');
  await writeFile(artifactPath, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
  return artifactPath;
}

async function writeArtifact(root: string, id: string, name: string, bytes: Buffer): Promise<string> {
  const base = join(root, ARTIFACT_ROOT);
  await mkdir(base, { recursive: true });
  const realBase = await realpath(base);
  if (!inside(root, realBase)) throw new Error('verification artifact directory escapes worktree');
  const runDir = join(realBase, id);
  await mkdir(runDir, { recursive: true });
  const realRunDir = await realpath(runDir);
  if (!inside(realBase, realRunDir)) throw new Error('verification run artifact directory escapes its root');
  const path = join(realRunDir, name);
  await writeFile(path, bytes, { flag: 'wx' });
  return path;
}

async function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 1_000 }).catch(() => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

async function runCommand(executable: string, args: string[], cwd: string, timeoutMs: number, cancelled: () => boolean, onOutput?: (s: string) => void) {
  return new Promise<{ status: VerificationCheckRun['status']; code: number | null; output: string; truncated: boolean; durationMs: number }>((resolveResult) => {
    const started = Date.now();
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: safeEnvironment() });
    let output = '';
    let truncated = false;
    let timedOut = false;
    let wasCancelled = false;
    const capture = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const room = VERIFICATION_LIMITS.outputCharsPerCheck - output.length;
      if (room > 0) {
        const accepted = text.slice(0, room);
        output += accepted;
        onOutput?.(accepted);
      }
      if (text.length > room) truncated = true;
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; void killTree(child); }, timeoutMs);
    const cancelTimer = setInterval(() => {
      if (cancelled()) { wasCancelled = true; void killTree(child); }
    }, 50);
    child.on('error', (error) => {
      clearTimeout(timer); clearInterval(cancelTimer);
      resolveResult({ status: 'infrastructure-error', code: null, output: `${output}\n${error.message}`.trim(), truncated, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer); clearInterval(cancelTimer);
      const noTests = output.includes('CEZAR_VERIFICATION_STATUS=no-tests');
      const status: VerificationCheckRun['status'] = wasCancelled ? 'cancelled' : timedOut ? 'infrastructure-error' : truncated ? 'unknown' : noTests ? 'no-tests' : code === 0 ? 'passed' : code === null ? 'infrastructure-error' : code === 1 ? 'failed' : 'infrastructure-error';
      resolveResult({ status, code, output, truncated, durationMs: Date.now() - started });
    });
  });
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const keep = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => keep.has(key) && value !== undefined));
}

async function incompleteRun(input: VerificationExecutionInput, root: string, raw: string, message: string): Promise<VerificationExecutionResult> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const headSha = await (await import('../server/git.ts')).getHeadCommit(root);
  if (!headSha) throw new Error('verification worktree has no readable HEAD commit');
  const safeMessage = sanitizeOutput(message, root, collectSecretValues()).slice(0, VERIFICATION_LIMITS.outputCharsPerCheck);
  const check: VerificationCheckRun = {
    checkId: 'manifest', required: true, attempt: 1, status: 'unknown', rawExitCode: null, semanticExitCode: 2,
    durationMs: 0, outputPreview: safeMessage, outputTruncated: false, diagnostics: [], metrics: [],
    coverage: { selected: 1, passed: 0, skipped: 0 }, artifacts: [],
  };
  const run = verificationRunSchema.parse({
    resultVersion: 1, verificationId: id, cezarRunId: input.cezarRunId, projectId: input.projectId,
    worktreeId: createHash('sha256').update(root).digest('hex').slice(0, 32), commitSha: headSha,
    manifestSha256: createHash('sha256').update(raw).digest('hex'), startedAt: now, finishedAt: now,
    toolVersions: { node: process.versions.node }, environment: { platform: process.platform, node: process.versions.node },
    status: 'unknown', semanticExitCode: 2,
    coverage: { selected: 1, passed: 0, failed: 0, skipped: 0, unknown: 1 }, checks: [check], artifacts: [],
  });
  const artifactPath = await writeResult(root, id, run);
  return { run, artifactPath, output: safeMessage, selection: { version: 1, mode: input.selection?.mode ?? 'all', suite: input.suite, changedPaths: [], fallbackUsed: true, checks: [] } };
}

/** Execute an explicitly selected project suite; shell parsing and host secrets are excluded. */
export async function executeVerification(input: VerificationExecutionInput): Promise<VerificationExecutionResult> {
  const root = await realpath(input.worktreePath);
  const manifestFile = join(root, MANIFEST_PATH);
  let raw = '';
  const manifestReal = await realpath(manifestFile).catch(() => undefined);
  if (manifestReal && !inside(root, manifestReal)) return incompleteRun(input, root, raw, 'verification manifest escapes worktree');
  try { raw = await readFile(manifestFile, 'utf8'); }
  catch (error) { return incompleteRun(input, root, raw, `verification manifest unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  let parsedYaml: unknown;
  try { parsedYaml = parseYaml(raw); }
  catch (error) { return incompleteRun(input, root, raw, `invalid verification YAML: ${error instanceof Error ? error.message : String(error)}`); }
  const parsed = verificationManifestSchema.safeParse((parsedYaml as { verification?: unknown } | null)?.verification);
  if (!parsed.success) return incompleteRun(input, root, raw, `invalid verification manifest: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  const manifest = parsed.data;
  const selected = manifest.suites[input.suite];
  if (!selected) return incompleteRun(input, root, raw, `unknown verification suite: ${input.suite}`);
  const selectionRequest = input.selection ?? { mode: 'all' as const };
  let selectionResult;
  try { selectionResult = await selectVerificationChecks(root, manifest, input.suite, selectionRequest); }
  catch (error) { return incompleteRun(input, root, raw, `verification selection failed: ${error instanceof Error ? error.message : String(error)}`); }
  let discovered: string[] = [];
  try { discovered = (await input.adapter?.discover?.(root)) ?? []; }
  catch { /* discovery is optional; an undeclared requirement remains unknown/skipped */ }
  const availableCapabilities = new Set([...(input.availableCapabilities ?? []), ...(discovered ?? [])]);
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const secretValues = collectSecretValues();
  const checkRuns: VerificationCheckRun[] = [];
  let combined = '';

  const selectedSet = new Set(selectionResult.selectedIds);
  for (const checkId of selectionResult.selectedIds) {
    const check = manifest.checks[checkId]!;
    const required = !check.optional;
    const checkStarted = Date.now();
    const target = resolve(root, check.cwd);
    const realTarget = await realpath(target).catch(() => target);
    const context: VerificationAdapterContext = { root, checkId, check, cwd: realTarget, cancelled: () => Boolean(input.cancelled?.()) };
    let status: VerificationCheckRun['status'];
    let rawExitCode: number | null = null;
    let output = '';
    let truncated = false;
    let durationMs = 0;
    const missingCapabilities = (check.requires ?? []).filter((capability) => !availableCapabilities.has(capability));
    let adapterOutcome: Awaited<ReturnType<NonNullable<VerificationAdapter['preflight']>>> | undefined;
    try {
      adapterOutcome = await input.adapter?.preflight?.(context);
    } catch (error) {
      adapterOutcome = { status: 'infrastructure-error', message: `adapter preflight failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!inside(root, realTarget)) {
      status = 'infrastructure-error'; output = 'verification cwd escapes worktree';
    } else if (adapterOutcome?.status) {
      status = adapterOutcome.status; output = adapterOutcome.message ?? `adapter preflight returned ${adapterOutcome.status}`;
    } else if (missingCapabilities.length) {
      status = check.optional ? 'skipped' : 'unknown';
      output = `unavailable capabilities: ${missingCapabilities.join(', ')}`;
    } else if (input.cancelled?.()) {
      status = 'cancelled'; output = 'verification cancelled before launch';
    } else {
      try {
        const execute = () => runCommand(check.executable, check.args, realTarget, check.timeoutSeconds * 1000, () => Boolean(input.cancelled?.()), (text) => input.onOutput?.(sanitizeOutput(text, root, secretValues)));
        const result = await withResources(check.resources ?? [], () => Boolean(input.cancelled?.()), () => input.adapter?.execute ? input.adapter.execute(context, execute) : execute());
        ({ status, code: rawExitCode, output, truncated, durationMs } = result);
      } catch (error) {
        status = input.cancelled?.() ? 'cancelled' : 'infrastructure-error'; output = error instanceof Error ? error.message : String(error); durationMs = Date.now() - checkStarted;
      }
    }
    const safeOutput = sanitizeOutput(output, root, secretValues);
    combined += `${checkId}: ${safeOutput}\n`;
    let checkRun: VerificationCheckRun = {
      checkId, required, attempt: 1, status, rawExitCode,
      semanticExitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : status === 'infrastructure-error' ? 3 : status === 'cancelled' ? 4 : 2,
      durationMs, outputPreview: safeOutput.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck), outputTruncated: truncated,
      diagnostics: [], metrics: [], coverage: { selected: 1, passed: status === 'passed' ? 1 : 0, skipped: status === 'skipped' ? 1 : 0 }, artifacts: [],
    };
    try { if (input.adapter?.collect) checkRun = await input.adapter.collect(context, checkRun); }
    catch (error) { checkRun = { ...checkRun, status: 'infrastructure-error', semanticExitCode: 3, outputTruncated: false, outputPreview: `adapter collect failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck), coverage: { selected: 1, passed: 0, skipped: 0 } }; }
    const redactedCheck: VerificationCheckRun = {
      ...checkRun,
      outputPreview: sanitizeOutput(checkRun.outputPreview, root, secretValues),
      diagnostics: checkRun.diagnostics.map((item) => ({ ...item, code: sanitizeOutput(item.code, root, secretValues), message: sanitizeOutput(item.message, root, secretValues), ...(item.file ? { file: sanitizeOutput(item.file, root, secretValues).replaceAll('\\', '/').replace(/^\.\//, '') } : {}) })),
    };
    const validCheck = verificationCheckRunSchema.safeParse(redactedCheck);
    if (!validCheck.success) {
      checkRun = { ...checkRun, checkId, required, status: 'infrastructure-error', semanticExitCode: 3, outputTruncated: false, outputPreview: `adapter returned an invalid check result: ${validCheck.error.issues.map((issue) => issue.message).join('; ')}`.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck), coverage: { selected: 1, passed: 0, skipped: 0 } };
    } else checkRun = validCheck.data;
    try { await input.adapter?.cleanup?.(context); }
    catch (error) { checkRun = { ...checkRun, status: 'infrastructure-error', semanticExitCode: 3, outputTruncated: false, outputPreview: `adapter cleanup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck), coverage: { selected: 1, passed: 0, skipped: 0 } }; }
    checkRuns.push(checkRun);
  }
  for (const checkId of selected) {
    if (selectedSet.has(checkId)) continue;
    checkRuns.push({ checkId, required: !manifest.checks[checkId]!.optional, attempt: 1, status: 'not-selected', rawExitCode: null, semanticExitCode: 2, durationMs: 0, outputPreview: '', outputTruncated: false, diagnostics: [], metrics: [], coverage: { selected: 0, passed: 0, skipped: 0 }, artifacts: [] });
  }
  checkRuns.sort((a, b) => selected.indexOf(a.checkId) - selected.indexOf(b.checkId));
  const status = aggregate(checkRuns);
  const headSha = await (await import('../server/git.ts')).getHeadCommit(root);
  if (!headSha) throw new Error('verification worktree has no readable HEAD commit');
  const selectionBytes = Buffer.from(`${JSON.stringify(selectionResult.selection, null, 2)}\n`, 'utf8');
  await writeArtifact(root, id, 'selection.json', selectionBytes);
  const selectionPath = `${ARTIFACT_ROOT}/${id}/selection.json`;
  const selectionArtifact = { path: selectionPath, mediaType: 'application/json', bytes: selectionBytes.length, sha256: createHash('sha256').update(selectionBytes).digest('hex') };
  const run: VerificationRun = verificationRunSchema.parse({
    resultVersion: 1, verificationId: id, cezarRunId: input.cezarRunId, projectId: input.projectId,
    worktreeId: createHash('sha256').update(root).digest('hex').slice(0, 32),
    commitSha: headSha,
    ...(selectionResult.selection.baseSha ? { baseSha: selectionResult.selection.baseSha } : {}),
    manifestSha256: createHash('sha256').update(raw).digest('hex'), startedAt, finishedAt: new Date().toISOString(),
    toolVersions: { node: process.versions.node, ...Object.fromEntries(Object.entries(manifest.checks).map(([key, value]) => [key, `unreported (${value.executable})`])) },
    environment: { platform: process.platform, node: process.versions.node }, status, semanticExitCode: semanticExit(status),
    coverage: { selected: checkRuns.reduce((n, c) => n + c.coverage.selected, 0), passed: checkRuns.filter((c) => c.status === 'passed').length, failed: checkRuns.filter((c) => c.status === 'failed').length, skipped: checkRuns.filter((c) => c.status === 'skipped').length, unknown: checkRuns.filter((c) => ['unknown', 'infrastructure-error', 'cancelled', 'no-tests'].includes(c.status)).length },
    checks: checkRuns, artifacts: [selectionArtifact],
  });
  const artifactPath = await writeResult(root, id, run);
  return { run, artifactPath, output: sanitizeOutput(combined, root, secretValues), selection: selectionResult.selection };
}
