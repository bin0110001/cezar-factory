import { createHash } from 'node:crypto';
import { evaluateScannerTrust } from '../scanner-trust-policy.js';
import {
  deriveCheckStatus, type CheckDefinition, type CheckResult, type CheckStatus,
} from './check-provider.js';
import {
  mergeByFingerprint, normalizeGenericJson, normalizeSarif, type NormalizedFinding,
} from './normalized-findings.js';

/**
 * Check runner (#618). Providers are plugins: the runner owns trust, timeout,
 * freshness, provenance, caching and status mapping, so no scanner brand
 * appears here. Execution failure or a stale/unavailable feed maps through the
 * check policy and can never become `pass`.
 */

export interface PluginRunInput {
  definition: CheckDefinition;
  sourceSha: string;
  scope: string;
  signal: AbortSignal;
}

export interface PluginRunOutput {
  format: 'sarif' | 'json';
  document: unknown;
  /** Advisory DB timestamp as reported by the isolated worker; absent when there is no DB. */
  dbUpdatedAt?: string;
  /** Digest of extra pinned inputs (e.g. a SAST ruleset): part of the cache key, so changing them misses the cache. */
  inputsDigest?: string;
  /** The provider has no advisory feed (e.g. a static analyser): a missing feed timestamp is not an outage. */
  noFeed?: boolean;
  /** The run completed but part of what it needed to examine did not run (e.g. an impacted suite): a clean result becomes `unknown` with this reason; a failing one stays failing. */
  unknown?: string;
  /** Set when the provider has nothing it can scan (e.g. no lockfile): reported as `unknown` with this reason, never pass. */
  notApplicable?: string;
  /** Verified identity of the scanner that actually ran. */
  observed?: { digest?: string; signer?: string; binaryPresent?: boolean };
}

export interface CheckProviderPlugin {
  /** Cheap pre-run probe of the advisory DB version so a cache hit can skip execution. */
  probe?(): Promise<{ dbUpdatedAt?: string; inputsDigest?: string }>;
  run(input: PluginRunInput): Promise<PluginRunOutput>;
}

export interface Provenance {
  sourceSha: string;
  providerName: string;
  providerVersion: string;
  providerDigest: string;
  configDigest: string;
  dbUpdatedAt: string;
  inputsDigest: string;
  artifactDigest: string;
  workerProfile: string;
  scope: string;
}

export interface RunCheckOptions {
  definition: CheckDefinition;
  plugin: CheckProviderPlugin;
  sourceSha: string;
  /** Scope key (e.g. changed-file digest). A changed scope never reuses a cached result (#593). */
  scope: string;
  /** Content digest of the inputs/artifact under test. */
  artifactDigest: string;
  workerProfile: string;
  /** Optional trusted-scanner policy (#604); when given, an untrusted scanner is not run to green. */
  trustPolicy?: unknown;
  cache?: CheckResultCache;
  now?: () => Date;
  secrets?: readonly string[];
}

export interface RunCheckOutcome {
  result: CheckResult;
  findings: NormalizedFinding[];
  provenance: Provenance;
  cacheHit: boolean;
}

const sha = (v: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;

export function configDigest(def: CheckDefinition): string {
  return sha(def);
}

/** Every dimension that must invalidate a cached result. */
export function cacheKey(p: Provenance): string {
  return sha([p.sourceSha, p.providerName, p.providerVersion, p.providerDigest, p.configDigest, p.dbUpdatedAt, p.inputsDigest, p.artifactDigest, p.workerProfile, p.scope]);
}

export class CheckResultCache {
  private readonly entries = new Map<string, { at: number; outcome: RunCheckOutcome }>();
  get(key: string, ttlHours: number | undefined, now: number): RunCheckOutcome | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (ttlHours !== undefined && now - hit.at > ttlHours * 3_600_000) { this.entries.delete(key); return undefined; }
    return hit.outcome;
  }
  set(key: string, outcome: RunCheckOutcome, now: number): void { this.entries.set(key, { at: now, outcome }); }
  get size(): number { return this.entries.size; }
}

function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T | 'timeout'> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { ctl.abort(); resolve('timeout'); }, ms); });
  return Promise.race([fn(ctl.signal), timeout]).finally(() => clearTimeout(timer));
}

function failure(def: CheckDefinition, prov: Provenance, execution: CheckResult['execution'], feed: CheckResult['feed'], reason: string): RunCheckOutcome {
  const status = deriveCheckStatus({ execution, feed, findingCount: 0, blockingFindingCount: 0, policy: def.policy });
  return { result: { checkId: def.id, provider: def.provider, status, execution, feed, findingCount: 0, blockingFindingCount: 0, reason }, findings: [], provenance: prov, cacheHit: false };
}

/** Findings at or above this severity block; lower severities warn. */
const BLOCKING = new Set(['critical', 'high']);

export async function runCheck(opts: RunCheckOptions): Promise<RunCheckOutcome> {
  const { definition: def, plugin } = opts;
  const now = (opts.now ?? (() => new Date()))();
  const prov: Provenance = {
    sourceSha: opts.sourceSha, providerName: def.provider.name, providerVersion: def.provider.version, providerDigest: def.provider.digest,
    configDigest: configDigest(def), dbUpdatedAt: '', inputsDigest: '', artifactDigest: opts.artifactDigest, workerProfile: opts.workerProfile, scope: opts.scope,
  };

  const cacheOn = def.policy.cache.enabled && opts.cache !== undefined;
  if (cacheOn && plugin.probe) {
    try {
      const probed = await plugin.probe();
      prov.dbUpdatedAt = probed.dbUpdatedAt ?? '';
      prov.inputsDigest = probed.inputsDigest ?? '';
      const hit = opts.cache!.get(cacheKey(prov), def.policy.cache.ttlHours, now.getTime());
      if (hit) return { ...hit, cacheHit: true };
    } catch { /* a failing probe just means no cache; the run decides the status */ }
  }

  let output: PluginRunOutput | 'timeout';
  try {
    output = await withTimeout(def.policy.timeoutMs, (signal) => plugin.run({ definition: def, sourceSha: opts.sourceSha, scope: opts.scope, signal }));
  } catch (e) {
    return failure(def, prov, 'failed', 'not-applicable', `provider failed: ${(e as Error).message}`.slice(0, 500));
  }
  if (output === 'timeout') return failure(def, prov, 'timeout', 'not-applicable', 'provider timed out');

  prov.dbUpdatedAt = output.dbUpdatedAt ?? '';
  prov.inputsDigest = output.inputsDigest ?? prov.inputsDigest;
  if (output.notApplicable) {
    return { result: { checkId: def.id, provider: def.provider, status: 'unknown', execution: 'not-run', feed: 'not-applicable', findingCount: 0, blockingFindingCount: 0, reason: `not applicable: ${output.notApplicable}`.slice(0, 500) }, findings: [], provenance: prov, cacheHit: false };
  }
  const key = cacheKey(prov);

  if (opts.trustPolicy) {
    const trust = evaluateScannerTrust(opts.trustPolicy, {
      binaryPresent: output.observed?.binaryPresent ?? true, observedDigest: output.observed?.digest ?? def.provider.digest,
      verifiedSigner: output.observed?.signer, dbUpdatedAt: output.dbUpdatedAt, now: now.toISOString(),
    });
    if (!trust.trusted) {
      const feed = trust.reasons.some((r) => r === 'db_missing' || r === 'db_expired') ? 'unavailable' : 'not-applicable';
      const status: CheckStatus = trust.outcome === 'fail' ? 'fail' : deriveCheckStatus({ execution: 'completed', feed: 'unavailable', findingCount: 0, blockingFindingCount: 0, policy: def.policy });
      return { ...failure(def, prov, 'completed', feed, `untrusted scanner: ${trust.reasons.join(', ')}`), result: { checkId: def.id, provider: def.provider, status, execution: 'completed', feed, findingCount: 0, blockingFindingCount: 0, reason: `untrusted scanner: ${trust.reasons.join(', ')}` } };
    }
  }

  const age = output.dbUpdatedAt ? now.getTime() - Date.parse(output.dbUpdatedAt) : NaN;
  const stale = def.policy.maxAgeHours !== undefined && !(age <= def.policy.maxAgeHours * 3_600_000);
  const feed: CheckResult['feed'] = output.dbUpdatedAt === undefined ? 'not-applicable' : stale ? 'stale' : 'fresh';
  if (def.policy.maxAgeHours !== undefined && output.dbUpdatedAt === undefined && !output.noFeed) return failure(def, prov, 'completed', 'unavailable', 'advisory feed missing');

  let findings: NormalizedFinding[];
  try {
    const nctx = { provider: def.provider, category: def.category, sourceSha: opts.sourceSha, secrets: opts.secrets };
    findings = output.format === 'sarif' ? normalizeSarif(output.document, nctx) : normalizeGenericJson(output.document, nctx);
  } catch (e) {
    return failure(def, prov, 'failed', feed, `unparseable provider output: ${(e as Error).message}`.slice(0, 500));
  }
  const active = findings.filter((f) => f.waiver.status === 'none');
  const blocking = active.filter((f) => BLOCKING.has(f.severity)).length;
  const derived = deriveCheckStatus({ execution: 'completed', feed, findingCount: active.length, blockingFindingCount: blocking, policy: def.policy });
  // Incomplete coverage can only make a clean result unknown; it never hides a finding and never turns a failure into a pass.
  const status: CheckStatus = output.unknown && (derived === 'pass' || derived === 'warn') ? 'unknown' : derived;
  const outcome: RunCheckOutcome = {
    result: { checkId: def.id, provider: def.provider, status, execution: 'completed', feed, findingCount: active.length, blockingFindingCount: blocking, ...(output.unknown ? { reason: output.unknown.slice(0, 500) } : {}) },
    findings, provenance: prov, cacheHit: false,
  };
  // Only a clean, fresh run is reusable; failures and stale feeds are always re-evaluated.
  if (cacheOn && feed !== 'stale') opts.cache!.set(key, outcome, now.getTime());
  return outcome;
}

const RANK: Record<CheckStatus, number> = { error: 4, fail: 3, unknown: 2, warn: 1, pass: 0, 'not-applicable': 0 };

/** Several providers for one category: worst status wins, findings merge by common fingerprint. */
export function aggregateCategory(outcomes: readonly RunCheckOutcome[]): { status: CheckStatus; findings: NormalizedFinding[] } {
  if (!outcomes.length) return { status: 'unknown', findings: [] };
  const status = outcomes.reduce<CheckStatus>((w, o) => (RANK[o.result.status] > RANK[w] ? o.result.status : w), 'pass');
  return { status, findings: outcomes.reduce<NormalizedFinding[]>((acc, o) => mergeByFingerprint(acc, o.findings), []) };
}
