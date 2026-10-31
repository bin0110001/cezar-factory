import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { nodeScriptCommand } from '../core/disclaim-spawn.ts';
import {
  VERIFICATION_LIMITS, verificationCheckRunSchema, verificationManifestSchema, verificationRunSchema,
  type VerificationCheckRun, type VerificationManifest, type VerificationRun,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';

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
  /** Report the version from the same environment that executes the check. */
  toolVersion?(context: VerificationAdapterContext): Promise<string | undefined>;
  preflight?(context: VerificationAdapterContext): Promise<{ status?: 'skipped' | 'unknown' | 'infrastructure-error'; message?: string }>;
  execute?(context: VerificationAdapterContext, runCommand: () => Promise<{ status: VerificationCheckRun['status']; code: number | null; output: string; truncated: boolean; durationMs: number }>): ReturnType<typeof runCommand>;
  collect?(context: VerificationAdapterContext, result: VerificationCheckRun): Promise<VerificationCheckRun>;
  cleanup?(context: VerificationAdapterContext): Promise<void>;
}

export interface VerificationExecutionResult {
  run: VerificationRun;
  artifactPath: string;
  output: string;
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
  if (checks.some((c) => c.status === 'no-tests') || checks.length === 0) return 'no-tests';
  if (checks.some((c) => c.required && c.status === 'skipped')) return 'skipped';
  return 'passed';
}

function checkRunConsistent(check: VerificationCheckRun): boolean {
  const expectedExit = check.status === 'passed' ? 0 : check.status === 'failed' ? 1
    : check.status === 'infrastructure-error' ? 3 : check.status === 'cancelled' ? 4 : 2;
  const expectedCoverage = check.status === 'passed' ? [1, 1, 0]
    : check.status === 'skipped' ? [1, 0, 1] : [1, 0, 0];
  return check.semanticExitCode === expectedExit
    && check.coverage.selected === expectedCoverage[0]
    && check.coverage.passed === expectedCoverage[1]
    && check.coverage.skipped === expectedCoverage[2];
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function trailingSecretPrefixLength(text: string, secret: string): number {
  const patternLength = Math.min(secret.length - 1, text.length, VERIFICATION_LIMITS.outputCharsPerCheck);
  if (patternLength <= 0) return 0;
  const pattern = secret.slice(0, patternLength);
  const prefix = new Uint32Array(patternLength);
  for (let i = 1, matched = 0; i < patternLength; i++) {
    while (matched > 0 && pattern[i] !== pattern[matched]) matched = prefix[matched - 1]!;
    if (pattern[i] === pattern[matched]) matched++;
    prefix[i] = matched;
  }
  const tail = text.slice(-patternLength);
  let matched = 0;
  for (let i = 0; i < tail.length; i++) {
    while (matched > 0 && tail[i] !== pattern[matched]) matched = prefix[matched - 1]!;
    if (tail[i] === pattern[matched]) matched++;
    if (matched === patternLength && i < tail.length - 1) matched = prefix[matched - 1]!;
  }
  return matched;
}

function sanitizeOutput(text: string, root: string, secretValues: readonly string[], truncated = false): string {
  if (truncated) {
    let overlappingPrefix = 0;
    for (const secret of secretValues) overlappingPrefix = Math.max(overlappingPrefix, trailingSecretPrefixLength(text, secret));
    if (overlappingPrefix > 0) text = `${text.slice(0, -overlappingPrefix)}[REDACTED]`;
    text = text.replace(/(?:gh[pousr]_[A-Za-z0-9]{4,}|github_pat_[A-Za-z0-9_]{4,}|sk-ant-[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9_-]{4,}|AKIA[0-9A-Z]{4,}|ASIA[0-9A-Z]{4,}|AIza[0-9A-Za-z_-]{4,}|ya29\.[0-9A-Za-z_-]{4,}|xox[baprs]-[0-9A-Za-z-]{4,}|glpat-[0-9A-Za-z_-]{4,})$/i, '[REDACTED]');
  }
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutRoot = text.replace(new RegExp(escaped, 'gi'), '.').replaceAll(root.replaceAll('\\', '/'), '.');
  return redactSecrets(withoutRoot, secretValues);
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return end === text.length ? text : `${text.slice(0, end)} [preview omitted to fit the aggregate verification result limit]`;
}

async function writeResult(root: string, id: string, run: VerificationRun): Promise<string> {
  const base = join(root, ARTIFACT_ROOT);
  await mkdir(base, { recursive: true });
  const realBase = await realpath(base);
  if (!inside(root, realBase)) throw new Error('verification artifact directory escapes worktree');
  const runDir = join(realBase, id);
  await mkdir(runDir, { recursive: false });
  const realRunDir = await realpath(runDir);
  if (!inside(realBase, realRunDir)) throw new Error('verification run artifact directory escapes its root');
  const artifactPath = join(realRunDir, 'result.json');
  await writeFile(artifactPath, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
  return artifactPath;
}

async function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 1_000 }).catch(() => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

async function runCommand(executable: string, args: string[], cwd: string, timeoutMs: number, cancelled: () => boolean, onOutput?: (s: string, truncated: boolean) => void) {
  return new Promise<{ status: VerificationCheckRun['status']; code: number | null; output: string; truncated: boolean; durationMs: number }>((resolveResult) => {
    const started = Date.now();
    const [command, commandArgs] = nodeScriptCommand(executable, args);
    const child = spawn(command, commandArgs, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: safeEnvironment() });
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
      onOutput?.(output, truncated);
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
  return { run, artifactPath, output: safeMessage };
}

/** Execute an explicitly selected project suite; shell parsing and host secrets are excluded. */
export async function executeVerification(input: VerificationExecutionInput): Promise<VerificationExecutionResult> {
  const root = await realpath(input.worktreePath);
  const initialHead = await (await import('../server/git.ts')).getHeadCommit(root);
  if (!initialHead) throw new Error('verification worktree has no readable HEAD commit');
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
  const secretValues = collectSecretValues();
  let discovered: string[] = [];
  try { discovered = (await input.adapter?.discover?.(root)) ?? []; }
  catch { /* discovery is optional; an undeclared requirement remains unknown/skipped */ }
  const availableCapabilities = new Set([...(input.availableCapabilities ?? []), ...(discovered ?? [])]);
  const toolVersions: Record<string, string> = { node: process.versions.node };
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const checkRuns: VerificationCheckRun[] = [];
  let combined = '';

  for (const checkId of selected) {
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
        let versionCancelled = false;
        if (!Object.hasOwn(toolVersions, checkId)) {
          if (input.adapter?.execute) {
            let reported: string | undefined;
            try { reported = await input.adapter.toolVersion?.(context); } catch { /* version evidence is optional */ }
            toolVersions[checkId] = sanitizeOutput(reported ?? 'unavailable (adapter-managed)', root, secretValues).trim().slice(0, 256);
          } else {
            const version = await runCommand(check.executable, ['--version'], realTarget, 3_000, () => Boolean(input.cancelled?.()));
            toolVersions[checkId] = sanitizeOutput(version.output, root, secretValues).trim().slice(0, 256) || 'unavailable';
            versionCancelled = version.status === 'cancelled';
          }
        }
        if (versionCancelled || input.cancelled?.()) {
          status = 'cancelled';
          output = 'verification cancelled during tool discovery';
        } else {
          const execute = () => runCommand(check.executable, check.args, realTarget, check.timeoutSeconds * 1000, () => Boolean(input.cancelled?.()), (text, outputTruncated) => input.onOutput?.(sanitizeOutput(text, root, secretValues, outputTruncated)));
          const result = await withResources(check.resources ?? [], () => Boolean(input.cancelled?.()), () => input.adapter?.execute ? input.adapter.execute(context, execute) : execute());
          ({ status, code: rawExitCode, output, truncated, durationMs } = result);
        }
      } catch (error) {
        status = input.cancelled?.() ? 'cancelled' : 'infrastructure-error'; output = error instanceof Error ? error.message : String(error); durationMs = Date.now() - checkStarted;
      }
    }
    const safeOutput = sanitizeOutput(output, root, secretValues, truncated);
    combined += `${checkId}: ${safeOutput}\n`;
    let checkRun: VerificationCheckRun = {
      checkId, required, attempt: 1, status, rawExitCode,
      semanticExitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : status === 'infrastructure-error' ? 3 : status === 'cancelled' ? 4 : 2,
      durationMs, outputPreview: safeOutput.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck), outputTruncated: truncated,
      diagnostics: [], metrics: [], coverage: { selected: 1, passed: status === 'passed' ? 1 : 0, skipped: status === 'skipped' ? 1 : 0 }, artifacts: [],
    };
    try { if (input.adapter?.collect) checkRun = await input.adapter.collect(context, checkRun); }
    catch (error) { checkRun = { ...checkRun, status: 'infrastructure-error', semanticExitCode: 3, outputTruncated: false, outputPreview: `adapter collect failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck), coverage: { selected: 1, passed: 0, skipped: 0 } }; }
    const validCheck = verificationCheckRunSchema.safeParse(checkRun);
    const consistencyError = validCheck.success && !checkRunConsistent(validCheck.data)
      ? 'adapter returned check semantics or coverage inconsistent with its status'
      : undefined;
    if (!validCheck.success || consistencyError) {
      const issueMessages = validCheck.success ? consistencyError : validCheck.error.issues.map((issue) => issue.message).join('; ');
      checkRun = {
        checkId, required, attempt: 1, status: 'infrastructure-error', rawExitCode: null, semanticExitCode: 3,
        durationMs: Math.max(0, Math.trunc(durationMs)), outputPreview: `adapter returned an invalid check result: ${issueMessages}`.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck),
        outputTruncated: false, diagnostics: [], metrics: [], coverage: { selected: 1, passed: 0, skipped: 0 }, artifacts: [],
      };
    } else checkRun = { ...validCheck.data, outputPreview: sanitizeOutput(validCheck.data.outputPreview, root, secretValues) };
    try { await input.adapter?.cleanup?.(context); }
    catch (error) { checkRun = { ...checkRun, status: 'infrastructure-error', semanticExitCode: 3, outputTruncated: false, outputPreview: `adapter cleanup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, VERIFICATION_LIMITS.outputCharsPerCheck), coverage: { selected: 1, passed: 0, skipped: 0 } }; }
    checkRuns.push(checkRun);
  }
  const headSha = await (await import('../server/git.ts')).getHeadCommit(root);
  if (!headSha) throw new Error('verification worktree has no readable HEAD commit');
  if (headSha !== initialHead) {
    const last = checkRuns[checkRuns.length - 1];
    if (last) {
      last.status = 'infrastructure-error';
      last.semanticExitCode = 3;
      last.outputPreview = 'worktree HEAD changed during verification; result is not attributable to the tested commit';
      last.outputTruncated = false;
      last.coverage = { selected: 1, passed: 0, skipped: 0 };
      combined += `${last.checkId}: worktree HEAD changed during verification; result is not attributable to the tested commit\n`;
    }
  }
  // Keep substantial room under the contract's 1 MiB serialized-result cap
  // for per-check diagnostics, metrics, artifacts, and JSON structure.
  const previewBudget = Math.floor(VERIFICATION_LIMITS.resultBytes / 4);
  const perCheckPreviewBudget = Math.floor(previewBudget / Math.max(1, checkRuns.length));
  for (const check of checkRuns) {
    if (Buffer.byteLength(check.outputPreview, 'utf8') <= perCheckPreviewBudget) continue;
    check.outputPreview = truncateUtf8(check.outputPreview, perCheckPreviewBudget);
    check.outputTruncated = true;
    check.status = 'unknown';
    check.semanticExitCode = 2;
    check.coverage = { selected: 1, passed: 0, skipped: 0 };
  }
  let diagnosticBytes = 0;
  let metricBytes = 0;
  let artifactCount = 0;
  const diagnosticBudget = Math.floor(VERIFICATION_LIMITS.resultBytes / 4);
  const metricBudget = Math.floor(VERIFICATION_LIMITS.resultBytes / 16);
  for (const check of checkRuns) {
    const diagnostics = [];
    for (const diagnostic of check.diagnostics) {
      const bytes = Buffer.byteLength(JSON.stringify(diagnostic), 'utf8');
      if (diagnosticBytes + bytes > diagnosticBudget) continue;
      diagnostics.push(diagnostic);
      diagnosticBytes += bytes;
    }
    const metrics = [];
    for (const metric of check.metrics) {
      const bytes = Buffer.byteLength(JSON.stringify(metric), 'utf8');
      if (metricBytes + bytes > metricBudget) continue;
      metrics.push(metric);
      metricBytes += bytes;
    }
    const artifacts = check.artifacts.slice(0, Math.max(0, VERIFICATION_LIMITS.artifactRefsPerRun - artifactCount));
    artifactCount += artifacts.length;
    const detailsOmitted = diagnostics.length !== check.diagnostics.length
      || metrics.length !== check.metrics.length || artifacts.length !== check.artifacts.length;
    check.diagnostics = diagnostics;
    check.metrics = metrics;
    check.artifacts = artifacts;
    if (detailsOmitted) {
      check.outputPreview = truncateUtf8(`${check.outputPreview} [details omitted to fit the aggregate verification result limit]`, perCheckPreviewBudget);
      check.outputTruncated = true;
      check.status = 'unknown';
      check.semanticExitCode = 2;
      check.coverage = { selected: 1, passed: 0, skipped: 0 };
    }
  }
  const status = aggregate(checkRuns);
  const runRecord = {
    resultVersion: 1, verificationId: id, cezarRunId: input.cezarRunId, projectId: input.projectId,
    worktreeId: createHash('sha256').update(root).digest('hex').slice(0, 32),
    commitSha: initialHead,
    manifestSha256: createHash('sha256').update(raw).digest('hex'), startedAt, finishedAt: new Date().toISOString(),
    toolVersions,
    environment: { platform: process.platform, node: process.versions.node }, status, semanticExitCode: semanticExit(status),
    coverage: { selected: checkRuns.length, passed: checkRuns.filter((c) => c.status === 'passed').length, failed: checkRuns.filter((c) => c.status === 'failed').length, skipped: checkRuns.filter((c) => c.status === 'skipped').length, unknown: checkRuns.filter((c) => ['unknown', 'infrastructure-error', 'cancelled', 'no-tests'].includes(c.status)).length },
    checks: checkRuns, artifacts: [],
  };
  if (Buffer.byteLength(JSON.stringify(runRecord), 'utf8') > VERIFICATION_LIMITS.resultBytes) {
    for (const check of checkRuns) {
      check.status = 'unknown';
      check.semanticExitCode = 2;
      check.outputPreview = 'verification details omitted to fit the aggregate result size limit';
      check.outputTruncated = true;
      check.diagnostics = [];
      check.metrics = [];
      check.artifacts = [];
      check.coverage = { selected: 1, passed: 0, skipped: 0 };
    }
    runRecord.status = aggregate(checkRuns);
    runRecord.semanticExitCode = semanticExit(runRecord.status);
    runRecord.coverage = { selected: checkRuns.length, passed: 0, failed: 0, skipped: 0, unknown: checkRuns.length };
  }
  const run: VerificationRun = verificationRunSchema.parse(runRecord);
  const artifactPath = await writeResult(root, id, run);
  return { run, artifactPath, output: sanitizeOutput(combined, root, secretValues) };
}
