import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { collectSecretValues, redactSecrets } from '../../../../core/secret-redaction.js';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Alibaba Open Code Review adapter (#781). OCR is called only through the injected isolated-worker executor;
 * this module never spawns a process. The executor must provide a disposable HOME, a read-only source checkout,
 * local-gateway-only egress, and a scrubbed environment containing only the explicit OCR variables below.
 */

export const OCR_PROVIDER_VERSION = '1.14.0';
export const OCR_MANIFEST_SCHEMA = 'ocr.run-manifest/v1';

export interface OcrExecResult { exitCode: number; stdout: string }
export type OcrExec = (argv: string[], env: Record<string, string>, signal: AbortSignal) => Promise<OcrExecResult>;

export interface OcrBudget {
  maxTokens: number;
  concurrency: number;
  timeoutMinutes: number;
}

export interface OcrUsage { tokens: number; costUsd: number; receiptId: string }

export interface OcrPluginOptions {
  repoPath: string;
  fromSha: string;
  toSha: string;
  expectedVersion?: string;
  gatewayUrl: string;
  gatewayToken: string;
  modelAlias: string;
  budget: OcrBudget;
  /** Digest of the enabled check's policy/configuration, supplied by the owner. */
  policyDigest: string;
  rulePath: string;
  ruleDigest: string;
  /** Collects usage from the local LiteLLM receipt store after the CLI exits. Missing usage is non-passing. */
  readUsage: (sessionId: string | undefined) => Promise<OcrUsage | undefined>;
  /** Runs `ocr version` through the same pinned worker image as the review invocation. */
  exec: OcrExec;
  observed?: () => Promise<NonNullable<PluginRunOutput['observed']>>;
}

type J = Record<string, unknown>;
const object = (v: unknown): J => v && typeof v === 'object' && !Array.isArray(v) ? v as J : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string | undefined => typeof v === 'string' && v.length ? v : undefined;
const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const FULL_SHA = /^[a-f0-9]{40}$/i;
const safePath = (v: unknown): string | undefined => {
  const path = string(v)?.replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || path.includes('\0')) return undefined;
  return path;
};

/** Only the approved local LiteLLM service can receive repository data. */
export function isApprovedOcrGateway(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'litellm' || host === 'host.containers.internal' || host === 'localhost' || host.endsWith('.local')) return true;
    if (!isIP(host)) return false;
    return host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '127.0.0.1' || host === '::1' || host.startsWith('fc') || host.startsWith('fd');
  } catch { return false; }
}

function validateOptions(o: OcrPluginOptions): void {
  if (!FULL_SHA.test(o.fromSha) || !FULL_SHA.test(o.toSha)) throw new Error('OCR review requires immutable full base and head revisions');
  if (!o.repoPath.startsWith('/')) throw new Error('OCR worker repoPath must be an absolute container path');
  if (!isApprovedOcrGateway(o.gatewayUrl)) throw new Error('OCR gateway must be the approved local LiteLLM endpoint');
  if (!o.gatewayToken.trim()) throw new Error('OCR gateway token is required');
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(o.modelAlias)) throw new Error('OCR model must be a configured LiteLLM alias');
  if (!Number.isSafeInteger(o.budget.maxTokens) || o.budget.maxTokens <= 0 || !Number.isInteger(o.budget.concurrency) || o.budget.concurrency < 1 || o.budget.concurrency > 4 || !Number.isInteger(o.budget.timeoutMinutes) || o.budget.timeoutMinutes < 1) {
    throw new Error('OCR token, concurrency, and timeout limits must be explicit positive bounds');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(o.ruleDigest)) throw new Error('OCR rule digest must be a sha256 digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(o.policyDigest)) throw new Error('OCR policy digest must be a sha256 digest');
  if (!o.rulePath.startsWith('/')) throw new Error('OCR rule path must be an absolute read-only worker path');
}

/** Environment is constructed from explicit inputs; caller environment and secrets never flow through wholesale. */
export function buildOcrEnvironment(o: Pick<OcrPluginOptions, 'gatewayUrl' | 'gatewayToken' | 'modelAlias'>): Record<string, string> {
  if (!isApprovedOcrGateway(o.gatewayUrl)) throw new Error('OCR gateway must be the approved local LiteLLM endpoint');
  if (!o.gatewayToken.trim()) throw new Error('OCR gateway token is required');
  return { OCR_LLM_URL: o.gatewayUrl, OCR_LLM_TOKEN: o.gatewayToken, OCR_LLM_MODEL: o.modelAlias, OCR_LLM_PROTOCOL: 'openai' };
}

export function buildOcrArgv(o: Pick<OcrPluginOptions, 'repoPath' | 'fromSha' | 'toSha' | 'modelAlias' | 'budget' | 'rulePath'>, mode: 'preview' | 'review'): string[] {
  const argv = ['ocr', 'review', '--repo', o.repoPath, '--from', o.fromSha, '--to', o.toSha, '--format', 'json', '--audience', 'agent',
    '--model', o.modelAlias, '--concurrency', String(o.budget.concurrency), '--timeout', String(o.budget.timeoutMinutes),
    '--max-tokens-budget', String(o.budget.maxTokens), '--rule', o.rulePath];
  if (mode === 'preview') argv.push('--preview');
  return argv;
}

function parseJson(text: string, phase: string): J {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
    return parsed as J;
  } catch (e) { throw new Error(`OCR ${phase} produced invalid JSON: ${(e as Error).message}`); }
}

function manifestOf(doc: J): J {
  const manifest = object(doc.manifest);
  if (manifest.schema_version !== OCR_MANIFEST_SCHEMA || manifest.operation !== 'review') throw new Error('OCR result has no supported review manifest');
  return manifest;
}

function manifestMatches(manifest: J, fromSha: string, toSha: string): boolean {
  const input = object(manifest.input);
  return input.mode === 'range' && input.resolved_base === fromSha && input.resolved_head === toSha;
}

function selectedPaths(manifest: J): string[] {
  const coverage = object(manifest.coverage);
  return array(coverage.selected).map((item) => safePath(object(item).path)).filter((path): path is string => Boolean(path));
}

function coveragePaths(coverage: J): string[] {
  return [...array(coverage.completed), ...array(coverage.reused)]
    .map((item) => safePath(object(item).path)).filter((path): path is string => Boolean(path));
}

export function ocrCommentFindings(doc: J, selected: ReadonlySet<string>, gatewayToken?: string): { findings: J[]; invalid: boolean } {
  const findings: J[] = [];
  let invalid = false;
  const sessionId = string(doc.session_id) ?? string(object(doc.manifest).run_id);
  const secrets = [...collectSecretValues(), ...(gatewayToken ? [gatewayToken] : [])];
  for (const raw of array(doc.comments)) {
    const c = object(raw);
    const path = safePath(c.path);
    const line = c.start_line;
    const claim = string(c.content)?.trim();
    if (!path || !selected.has(path) || !Number.isSafeInteger(line) || Number(line) < 1 || !claim) { invalid = true; continue; }
    const identity = sha([path, claim.toLowerCase().replace(/\s+/g, ' ').trim()]);
    findings.push({
      id: `ocr-${identity}`,
      severity: string(c.severity) ?? 'info',
      confidence: 'unknown',
      title: redactSecrets(claim, secrets),
      path,
      line,
      suggestion: string(c.suggestion_code) ? redactSecrets(string(c.suggestion_code)!, secrets).slice(0, 2000) : undefined,
      reviewerSessionId: sessionId,
      fingerprint: identity,
    });
  }
  return { findings, invalid };
}

function unavailable(reason: string, observed?: PluginRunOutput['observed']): PluginRunOutput {
  return { format: 'json', document: { findings: [] }, unknown: reason.slice(0, 500), ...(observed ? { observed } : {}) };
}

/** Convert the pinned CLI JSON/manifest into the existing generic finding contract. */
export function ocrPlugin(opts: OcrPluginOptions): CheckProviderPlugin {
  validateOptions(opts);
  const expectedVersion = opts.expectedVersion ?? OCR_PROVIDER_VERSION;
  const budgetPolicyDigest = `sha256:${sha({ budget: opts.budget, coverage: 'complete-only-v1', warnings: 'fail-closed-v1' })}`;
  const inputsDigest = `sha256:${sha([expectedVersion, opts.ruleDigest, opts.policyDigest, budgetPolicyDigest, opts.fromSha, opts.toSha, opts.gatewayUrl, opts.modelAlias])}`;
  const env = buildOcrEnvironment(opts);
  const commandEnv = { ...env, HOME: '/run/factory/ocr-home', TERM: 'dumb' };
  const common = async () => ({ inputsDigest, observed: await opts.observed?.() });

  return {
    probe: async () => ({ inputsDigest }),
    async run({ signal, sourceSha }): Promise<PluginRunOutput> {
      if (sourceSha.toLowerCase() !== opts.toSha.toLowerCase()) return unavailable('OCR head revision does not match the check source SHA', await opts.observed?.());
      const version = await opts.exec(['ocr', 'version'], commandEnv, signal);
      if (version.exitCode !== 0) return unavailable('OCR CLI version probe failed', await opts.observed?.());
      const versionText = version.stdout.match(/\b(?:v)?(\d+\.\d+\.\d+)\b/)?.[1];
      if (versionText !== expectedVersion) return unavailable(`OCR version mismatch: expected ${expectedVersion}, observed ${versionText ?? 'unknown'}`, await opts.observed?.());

      const previewResult = await opts.exec(buildOcrArgv(opts, 'preview'), commandEnv, signal);
      if (previewResult.exitCode !== 0) return unavailable('OCR preview failed', await opts.observed?.());
      const preview = parseJson(previewResult.stdout, 'preview');
      const previewManifest = manifestOf(preview);
      if (!manifestMatches(previewManifest, opts.fromSha, opts.toSha)) return unavailable('OCR preview manifest revision does not match the immutable input range', await opts.observed?.());
      const selected = selectedPaths(previewManifest);
      if (selected.length === 0) return { format: 'json', document: { findings: [] }, notApplicable: 'no supported changed files', ...(await common()) };

      const reviewResult = await opts.exec(buildOcrArgv(opts, 'review'), commandEnv, signal);
      let review: J;
      try { review = parseJson(reviewResult.stdout, 'review'); }
      catch (e) {
        if (reviewResult.exitCode !== 0) return unavailable('OCR provider or gateway unavailable; no usable structured results', await opts.observed?.());
        throw e;
      }
      const manifest = manifestOf(review);
      if (!manifestMatches(manifest, opts.fromSha, opts.toSha)) return unavailable('OCR result manifest revision does not match the immutable input range', await opts.observed?.());

      const coverage = object(manifest.coverage);
      const failed = array(coverage.failed).length;
      const waived = array(coverage.waived).length;
      const completed = array(coverage.completed).length + array(coverage.reused).length;
      const reviewSelected = selectedPaths(manifest);
      const expectedCount = reviewSelected.length;
      const previewSet = new Set(selected);
      const reviewSet = new Set(reviewSelected);
      const selectionChanged = previewSet.size !== reviewSet.size || [...previewSet].some((path) => !reviewSet.has(path));
      const covered = coveragePaths(coverage);
      const coveredSet = new Set(covered);
      const coverageMismatch = covered.length !== expectedCount || coveredSet.size !== expectedCount || [...reviewSet].some((path) => !coveredSet.has(path));
      const warnings = array(review.warnings).length;
      const toolFailures = Number(object(review.tool_calls).failure ?? 0);
      const { findings, invalid } = ocrCommentFindings(review, new Set(selected), opts.gatewayToken);
      const excluded = array(coverage.excluded).length;
      let incomplete = manifest.terminal_state !== 'complete' || failed > 0 || waived > 0 || excluded > 0 || completed !== expectedCount || coverageMismatch || selectionChanged || warnings > 0 || toolFailures > 0 || invalid || reviewResult.exitCode !== 0;
      const summary = object(review.summary);
      const sessionId = string(review.session_id) ?? string(manifest.run_id);
      const usage = await opts.readUsage(sessionId);
      const tokens = summary.total_tokens;
      if (!Number.isSafeInteger(tokens) || Number(tokens) < 0 || Number(tokens) > opts.budget.maxTokens) incomplete = true;
      if (!usage || !Number.isSafeInteger(usage.tokens) || usage.tokens < 0 || !Number.isFinite(usage.costUsd) || usage.costUsd < 0 || !usage.receiptId || usage.tokens !== Number(tokens) || usage.tokens > opts.budget.maxTokens) incomplete = true;

      // Keep recovered findings even when coverage/budget is incomplete, but never convert that run into a clean pass.
      return {
        format: 'json', document: { findings },
        ...(incomplete ? { unknown: 'OCR review incomplete, failed, uncovered, over budget, or missing gateway usage receipt' } : {}),
        ...await common(),
      };
    },
  };
}
