import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  VERIFICATION_LIMITS,
  verificationManifestSchema,
  verificationStatusSchema,
  type VerificationCheckRun,
  type VerificationManifest,
  type VerificationStatus,
} from '@open-mercato/cezar-contract';

export type CheckExecution = {
  checkId: string;
  check: VerificationManifest['checks'][string];
  status: VerificationStatus;
  rawExitCode: number | null;
  semanticExitCode: 0 | 1 | 2 | 3 | 4;
  durationMs: number;
  outputPreview: string;
  outputTruncated: boolean;
  diagnostics: VerificationCheckRun['diagnostics'];
  metrics: VerificationCheckRun['metrics'];
  coverage: VerificationCheckRun['coverage'];
  artifacts: VerificationCheckRun['artifacts'];
};

export type ExecuteOptions = {
  projectRoot: string;
  capabilities?: ReadonlySet<string>;
  signal?: AbortSignal;
  /** Values from the runner are never copied into this command's environment. */
  env?: Record<string, string>;
};

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
  /((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
];
export function redactVerificationOutput(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '$1[REDACTED]'), value);
}

function envForCommand(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /TOKEN|SECRET|PASSWORD|API.?KEY/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

async function safeCwd(projectRoot: string, cwd: string): Promise<string> {
  const root = await realpath(projectRoot);
  const target = await realpath(resolve(root, cwd));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('cwd escapes project root');
  if (!(await stat(target)).isDirectory()) throw new Error('cwd is not a directory');
  return target;
}

function resultStatus(code: number | null, timeout: boolean, cancelled: boolean, truncated: boolean): { status: VerificationStatus; semanticExitCode: 0 | 1 | 2 | 3 | 4 } {
  if (cancelled) return { status: 'cancelled', semanticExitCode: 4 };
  if (timeout || code === null) return { status: 'infrastructure-error', semanticExitCode: 3 };
  if (truncated) return { status: 'unknown', semanticExitCode: 2 };
  if (code === 0) return { status: 'passed', semanticExitCode: 0 };
  if (code === 1) return { status: 'failed', semanticExitCode: 1 };
  if (code === 2) return { status: 'no-tests', semanticExitCode: 2 };
  return { status: 'infrastructure-error', semanticExitCode: 3 };
}

async function terminateTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Terminate the owned process immediately so cancellation never depends on taskkill being
    // permitted by the host. taskkill /T is still attempted for descendants when available.
    child.kill();
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    await Promise.race([
      new Promise<void>((resolveDone) => killer.once('close', () => resolveDone())),
      new Promise<void>((resolveDone) => setTimeout(resolveDone, 500)),
    ]);
    if (killer.exitCode === null && killer.signalCode === null) killer.kill();
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await new Promise((resolveDone) => setTimeout(resolveDone, 250));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

export async function executeCheck(checkId: string, check: VerificationManifest['checks'][string], options: ExecuteOptions): Promise<CheckExecution> {
  const start = Date.now();
  const capabilities = options.capabilities ?? new Set<string>();
  const missing = (check.requires ?? []).filter((capability) => !capabilities.has(capability));
  if (missing.length) {
    return {
      checkId, check, status: check.optional ? 'skipped' : 'unknown', rawExitCode: null,
      semanticExitCode: 2, durationMs: Date.now() - start,
      outputPreview: '', outputTruncated: false,
      diagnostics: [{ code: 'missing-capability', severity: 'warning', message: `Missing capabilities: ${missing.join(', ')}` }],
      metrics: [], coverage: { selected: 1, passed: 0, skipped: 1 }, artifacts: [],
    };
  }

  let cwd: string;
  try { cwd = await safeCwd(options.projectRoot, check.cwd); }
  catch (error) {
    return {
      checkId, check, status: 'unknown', rawExitCode: null, semanticExitCode: 2,
      durationMs: Date.now() - start, outputPreview: '', outputTruncated: false,
      diagnostics: [{ code: 'invalid-cwd', severity: 'error', message: error instanceof Error ? error.message : 'invalid cwd' }],
      metrics: [], coverage: { selected: 1, passed: 0, skipped: 0 }, artifacts: [],
    };
  }

  const timeoutMs = check.timeoutSeconds * 1_000;
  let output = '';
  let outputTruncated = false;
  let timedOut = false;
  let cancelled = false;
  let launchFailed = false;
  const startedAt = Date.now();
  const child = spawn(check.executable, check.args, {
    cwd,
    env: envForCommand(options.env),
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk: Buffer) => {
    const remaining = VERIFICATION_LIMITS.outputCharsPerCheck - output.length;
    const text = chunk.toString('utf8');
    if (text.length > remaining) { output += text.slice(0, Math.max(0, remaining)); outputTruncated = true; }
    else output += text;
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', () => { launchFailed = true; });

  let stopReason: 'timeout' | 'cancelled' | undefined;
  const stop = async (reason: 'timeout' | 'cancelled') => {
    if (stopReason) return;
    stopReason = reason;
    timedOut = reason === 'timeout';
    cancelled = reason === 'cancelled';
    await terminateTree(child);
  };
  const timer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
  const abort = () => { void stop('cancelled'); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const rawExitCode = await new Promise<number | null>((resolveCode) => child.once('close', (code) => resolveCode(code)));
  clearTimeout(timer);
  options.signal?.removeEventListener('abort', abort);
  if (launchFailed) {
    output = `${output}\nUnable to start executable: ${check.executable}`;
  }
  const statusResult = resultStatus(rawExitCode, timedOut || launchFailed, cancelled, outputTruncated);
  const safeOutput = redactVerificationOutput(output);
  return {
    checkId, check, status: statusResult.status, rawExitCode,
    semanticExitCode: statusResult.semanticExitCode,
    durationMs: Date.now() - startedAt,
    outputPreview: safeOutput.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck),
    outputTruncated,
    diagnostics: outputTruncated
      ? [{ code: 'output-truncated', severity: 'error', message: 'Combined output exceeded the per-check limit; result is inconclusive.' }]
      : launchFailed ? [{ code: 'launch-failed', severity: 'error', message: `Could not launch ${check.executable}.` }]
        : timedOut ? [{ code: 'timeout', severity: 'error', message: `Check exceeded ${check.timeoutSeconds} seconds.` }]
          : [],
    metrics: [],
    coverage: { selected: 1, passed: statusResult.status === 'passed' ? 1 : 0, skipped: statusResult.status === 'skipped' ? 1 : 0 },
    artifacts: [],
  };
}

export function selectChecks(manifest: VerificationManifest, suite: string): string[] {
  const ids = manifest.suites[suite];
  if (!ids) throw new Error(`Unknown verification suite: ${suite}`);
  return [...ids];
}

export async function executeSuite(rawManifest: unknown, suite: string, options: ExecuteOptions) {
  const manifestResult = verificationManifestSchema.safeParse(rawManifest);
  if (!manifestResult.success) {
    return { status: 'unknown' as const, semanticExitCode: 2 as const, checks: [], diagnostics: manifestResult.error.issues.map((issue) => issue.message) };
  }
  const manifest = manifestResult.data;
  let ids: string[];
  try { ids = selectChecks(manifest, suite); }
  catch (error) { return { status: 'unknown' as const, semanticExitCode: 2 as const, checks: [], diagnostics: [String(error)] }; }
  const locks = new Map<string, Promise<void>>();
  const completed: CheckExecution[] = [];
  for (const id of ids) {
    if (options.signal?.aborted) {
      completed.push({ checkId: id, check: manifest.checks[id]!, status: 'cancelled', rawExitCode: null, semanticExitCode: 4, durationMs: 0, outputPreview: '', outputTruncated: false, diagnostics: [], metrics: [], coverage: { selected: 1, passed: 0, skipped: 0 }, artifacts: [] });
      continue;
    }
    const check = manifest.checks[id]!;
    const resources = [...new Set(check.resources ?? [])].sort();
    const previous = Promise.all(resources.map((resource) => locks.get(resource)).filter((p): p is Promise<void> => p !== undefined));
    let release!: () => void;
    const current = new Promise<void>((resolveDone) => { release = resolveDone; });
    for (const resource of resources) locks.set(resource, previous.then(() => current));
    await previous;
    try { completed.push(await executeCheck(id, check, options)); }
    finally { release(); }
  }
  const required = completed.filter((result) => !result.check.optional);
  let status: VerificationStatus;
  if (required.some((result) => result.status === 'cancelled')) status = 'cancelled';
  else if (required.some((result) => result.status === 'infrastructure-error')) status = 'infrastructure-error';
  else if (required.some((result) => result.status === 'failed')) status = 'failed';
  else if (required.some((result) => result.status !== 'passed')) status = 'unknown';
  else status = 'passed';
  const semanticExitCode = status === 'passed' ? 0 : status === 'failed' ? 1 : status === 'cancelled' ? 4 : status === 'infrastructure-error' ? 3 : 2;
  return { status, semanticExitCode, checks: completed, diagnostics: [] as string[] };
}

export function manifestDigest(rawManifest: unknown): string {
  const manifest = verificationManifestSchema.parse(rawManifest);
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function artifactReference(path: string, mediaType: string, bytes: number, sha256: string) {
  if (isAbsolute(path) || path.includes('\\')) throw new Error('artifact path must be relative');
  if (path.split('/').some((part) => part === '..' || part === '.')) throw new Error('artifact path must be normalized');
  const rel = relative('.', resolve('.', path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('artifact path must be relative');
  return { path: rel.split(sep).join('/'), mediaType, bytes, sha256 };
}

export { verificationStatusSchema };
