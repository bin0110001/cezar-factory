/** Typed quota-admission policy used by Cezar before provider dispatch.
 *
 * The Python capacity package remains the reference implementation. This module deliberately
 * contains no account credentials and is pure so the durable run/lease owner can supply fresh
 * snapshots and atomically persist the decision.
 */
export type CapacityState = 'unknown' | 'available' | 'constrained' | 'exhausted' | 'stale' | 'disabled';
export type UnknownCapacityMode = 'conservative' | 'optimistic';

export function capacityAdapterForRunner(runner: string): string {
  const adapters: Record<string, string> = {
    claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode', cursor: 'cursor-agent',
    pi: 'pi', junie: 'junie', copilot: 'copilot-cli',
  };
  return adapters[runner] ?? runner;
}

export interface CapacityWindow {
  name: string;
  limit?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  observedAt?: string | null;
  stalenessSeconds?: number;
}

export interface SubscriptionCapacityProfile {
  id: string;
  provider: string;
  /** Resolved host agent-account id. Derived from credentialRef at load time and never serialized. */
  agentAccountId?: string;
  adapters?: string[];
  enabled: boolean;
  maxConcurrency: number;
  allowedModelIds: string[];
  windows: CapacityWindow[];
}

export interface CapacityCandidate {
  profileId: string;
  provider: string;
  modelId: string;
  /** Estimated units consumed per invocation, keyed by capacity-window name; omitted windows
   * reserve one unit, matching the Python policy's conservative default. */
  estimatedCost: Readonly<Record<string, number>>;
}

export interface CapacityReservation {
  profileId: string;
  provider: string;
  modelId: string;
  windowCosts: Readonly<Record<string, number>>;
}

export interface AdmissionContext {
  now: number;
  activeByProfile: Readonly<Record<string, number>>;
  unknownProbeByProfile?: Readonly<Record<string, number>>;
  activeReleaseAtByProfile?: Readonly<Record<string, readonly number[]>>;
  reservedByProfileAndWindow: Readonly<Record<string, Readonly<Record<string, number>>>>;
  reservedReleaseSchedule?: Readonly<Record<string, Readonly<Record<string, readonly { at: number; cost: number }[]>>>>;
  unknownMode: UnknownCapacityMode;
  optimisticUnknownLimit?: number;
}

export type AdmissionResult =
  | { status: 'admitted'; reservation: CapacityReservation; state: CapacityState; duplicate?: true }
  | { status: 'deferred'; reason: string; retryAt?: number; state: CapacityState }
  | { status: 'ineligible'; reason: string; state: CapacityState };

export interface RoutedAdmissionResult {
  result: AdmissionResult;
  candidate?: CapacityCandidate;
  candidateIndex?: number;
  rejections: Array<{ candidateIndex: number; reason: string; status: 'deferred' | 'ineligible' }>;
}

export interface AdmissionRetryPolicy {
  baseBackoffSeconds: number;
  maxBackoffSeconds: number;
  jitterFraction: number;
  maxAttempts: number;
  agingPerHour: number;
}

export interface QuotaLease extends CapacityReservation {
  jobId: string;
  expiresAt: number;
  unknownCapacity: boolean;
}

export interface DeferredQuotaJob {
  jobId: string;
  candidates: CapacityCandidate[];
  priority: number;
  enqueuedAt: number;
  attempts: number;
  notBefore?: number;
  reason: string;
  retryAt?: number;
}

export interface QuotaAdmissionSnapshot {
  schemaVersion: 1;
  leases: QuotaLease[];
  deferred: DeferredQuotaJob[];
  cooldowns: Array<{ provider: string; window: string; until: number }>;
  failures: Record<string, number>;
}

export interface QuotaAdmissionOptions {
  leaseSeconds?: number;
  policy?: AdmissionRetryPolicy;
  random?: () => number;
}

export const DEFAULT_ADMISSION_RETRY_POLICY: Readonly<AdmissionRetryPolicy> = {
  baseBackoffSeconds: 30,
  maxBackoffSeconds: 3600,
  jitterFraction: 0.2,
  maxAttempts: 8,
  agingPerHour: 1,
};

/** Bounded retry delay matching the Python reference. The injected random value keeps tests
 * deterministic; adapters should provide a value in [0, 1). */
export function admissionRetryDelaySeconds(
  attempt: number,
  retryAfterSeconds: number | undefined,
  random: number,
  policy: AdmissionRetryPolicy = DEFAULT_ADMISSION_RETRY_POLICY,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  if (!Number.isFinite(random) || random < 0 || random >= 1) throw new RangeError('random must be in [0, 1)');
  const boundedMax = Math.max(0, policy.maxBackoffSeconds);
  const exponential = Math.min(boundedMax, Math.max(0, policy.baseBackoffSeconds) * 2 ** (attempt - 1));
  const serverDelay = validNonNegative(retryAfterSeconds) ? retryAfterSeconds : 0;
  const jittered = Math.max(exponential, serverDelay) * (1 + Math.max(0, policy.jitterFraction) * random);
  return Math.min(boundedMax, jittered);
}

export function effectiveAdmissionPriority(
  priority: number,
  enqueuedAt: number,
  now: number,
  agingPerHour = DEFAULT_ADMISSION_RETRY_POLICY.agingPerHour,
): number {
  const waitedHours = Math.max(0, now - enqueuedAt) / 3_600_000;
  return priority + Math.max(0, agingPerHour) * waitedHours;
}

/** Stateful quota ledger. A single instance must be shared across all project run managers in
 * the workspace. Callers persist `snapshot()` under their workspace lock and restore it on boot. */
export class QuotaAdmissionController {
  private readonly leases = new Map<string, QuotaLease>();
  private readonly deferred = new Map<string, DeferredQuotaJob>();
  private readonly cooldowns = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly leaseSeconds: number;
  private readonly policy: AdmissionRetryPolicy;
  private readonly random: () => number;

  constructor(options: QuotaAdmissionOptions = {}, snapshot?: QuotaAdmissionSnapshot) {
    this.leaseSeconds = Math.max(1, options.leaseSeconds ?? 1800);
    this.policy = options.policy ?? DEFAULT_ADMISSION_RETRY_POLICY;
    this.random = options.random ?? Math.random;
    if (snapshot) this.restore(snapshot);
  }

  private expire(now: number): string[] {
    const expired: string[] = [];
    for (const [jobId, lease] of this.leases) {
      if (lease.expiresAt <= now) { this.leases.delete(jobId); expired.push(jobId); }
    }
    return expired;
  }

  private context(now: number, unknownMode: UnknownCapacityMode): AdmissionContext {
    const activeByProfile: Record<string, number> = {};
    const unknownProbeByProfile: Record<string, number> = {};
    const activeReleaseAtByProfile: Record<string, number[]> = {};
    const reservedByProfileAndWindow: Record<string, Record<string, number>> = {};
    const reservedReleaseSchedule: Record<string, Record<string, Array<{ at: number; cost: number }>>> = {};
    for (const lease of this.leases.values()) {
      activeByProfile[lease.profileId] = (activeByProfile[lease.profileId] ?? 0) + 1;
      (activeReleaseAtByProfile[lease.profileId] ??= []).push(lease.expiresAt);
      if (lease.unknownCapacity) unknownProbeByProfile[lease.profileId] = (unknownProbeByProfile[lease.profileId] ?? 0) + 1;
      const windows = reservedByProfileAndWindow[lease.profileId] ??= {};
      const schedules = reservedReleaseSchedule[lease.profileId] ??= {};
      for (const [name, cost] of Object.entries(lease.windowCosts)) {
        windows[name] = (windows[name] ?? 0) + cost;
        (schedules[name] ??= []).push({ at: lease.expiresAt, cost });
      }
    }
    return { now, activeByProfile, unknownProbeByProfile, activeReleaseAtByProfile, reservedByProfileAndWindow, reservedReleaseSchedule, unknownMode };
  }

  private defer(
    jobId: string,
    candidates: readonly CapacityCandidate[],
    priority: number,
    result: Exclude<AdmissionResult, { status: 'admitted' }>,
    now: number,
  ): AdmissionResult {
    const old = this.deferred.get(jobId);
    const attempts = (old?.attempts ?? 0) + 1;
    const delay = admissionRetryDelaySeconds(attempts, undefined, this.random(), this.policy);
    const backoffAt = now + delay * 1000;
    const retryAt = result.status === 'deferred' && result.retryAt !== undefined
      ? Math.max(result.retryAt, backoffAt) : backoffAt;
    const item: DeferredQuotaJob = {
      jobId,
      candidates: candidates.map((candidate) => ({ ...candidate, estimatedCost: { ...candidate.estimatedCost } })),
      priority: old?.priority ?? priority,
      enqueuedAt: old?.enqueuedAt ?? now,
      attempts,
      // maxAttempts caps exponential growth; it does not abandon work. Continue
      // retrying at the bounded ceiling so capacity recovery remains automatic.
      notBefore: retryAt,
      reason: result.reason,
      retryAt,
    };
    this.deferred.set(jobId, item);
    return { status: 'deferred', reason: item.reason, retryAt: item.retryAt, state: result.state };
  }

  admit(
    jobId: string,
    candidates: readonly CapacityCandidate[],
    profiles: ReadonlyMap<string, SubscriptionCapacityProfile>,
    options: { priority?: number; now?: number; unknownMode?: UnknownCapacityMode; optimisticUnknownLimit?: number } = {},
  ): AdmissionResult {
    const now = options.now ?? Date.now();
    this.expire(now);
    const existing = this.leases.get(jobId);
    if (existing) return {
      status: 'admitted',
      reservation: { profileId: existing.profileId, provider: existing.provider, modelId: existing.modelId, windowCosts: existing.windowCosts },
      state: 'available',
      duplicate: true,
    };
    const waiting = this.deferred.get(jobId);
    if (waiting?.notBefore !== undefined && waiting.notBefore > now) {
      return { status: 'deferred', reason: waiting.reason, retryAt: waiting.notBefore, state: 'unknown' };
    }
    let last: AdmissionResult = { status: 'ineligible', reason: 'no-routing-candidates', state: 'unknown' };
    let earliestRetry: number | undefined;
    for (const candidate of candidates) {
      const profile = profiles.get(candidate.profileId);
      if (!profile) { last = { status: 'ineligible', reason: 'unknown-profile', state: 'unknown' }; continue; }
      const cooldowns = profile.windows.filter((window) => (this.cooldowns.get(`${profile.provider}\0${window.name}`) ?? 0) > now);
      if (cooldowns.length) {
        const until = Math.max(...cooldowns.map((window) => this.cooldowns.get(`${profile.provider}\0${window.name}`)!));
        last = { status: 'deferred', reason: `provider-cooldown:${profile.provider}`, retryAt: until, state: 'exhausted' };
        continue;
      }
      const context = this.context(now, options.unknownMode ?? 'conservative');
      if (options.optimisticUnknownLimit !== undefined) context.optimisticUnknownLimit = options.optimisticUnknownLimit;
      const result = evaluateCandidateAdmission(profile, candidate, context);
      if (result.status === 'admitted') {
        const unknownCapacity = result.state === 'unknown' || result.state === 'stale';
        this.leases.set(jobId, {
          jobId, ...result.reservation, expiresAt: now + this.leaseSeconds * 1000, unknownCapacity,
        });
        this.deferred.delete(jobId);
        return result;
      }
      last = result;
      if (result.status === 'deferred' && result.retryAt !== undefined) {
        earliestRetry = earliestRetry === undefined ? result.retryAt : Math.min(earliestRetry, result.retryAt);
      }
    }
    if (last.status === 'ineligible') return last;
    if (earliestRetry !== undefined && last.status === 'deferred') last = { ...last, retryAt: earliestRetry };
    return this.defer(jobId, candidates, options.priority ?? 0, last, now);
  }

  deferUnknownModel(jobId: string, now = Date.now(), priority = 0): AdmissionResult {
    const result: Exclude<AdmissionResult, { status: 'admitted' }> = {
      status: 'deferred', reason: 'model-identity-unknown',
      retryAt: now + this.policy.baseBackoffSeconds * 1000, state: 'unknown',
    };
    return this.defer(jobId, [], priority, result, now);
  }

  heartbeat(jobId: string, now = Date.now()): boolean {
    const lease = this.leases.get(jobId);
    if (!lease) return false;
    lease.expiresAt = now + this.leaseSeconds * 1000;
    return true;
  }

  rekeyLease(fromJobId: string, toJobId: string): boolean {
    if (fromJobId === toJobId) return this.leases.has(fromJobId);
    const lease = this.leases.get(fromJobId);
    if (!lease || this.leases.has(toJobId)) return false;
    this.leases.delete(fromJobId);
    lease.jobId = toJobId;
    this.leases.set(toJobId, lease);
    return true;
  }

  complete(jobId: string): boolean {
    const lease = this.leases.get(jobId);
    if (!lease) return false;
    this.leases.delete(jobId);
    this.failures.set(lease.provider, 0);
    return true;
  }

  release(jobId: string): boolean { return this.leases.delete(jobId); }

  reportRateLimit(jobId: string, provider: string, window: string, retryAfterSeconds?: number, now = Date.now()): number {
    this.leases.delete(jobId);
    const streak = this.failures.get(provider) ?? 0;
    this.failures.set(provider, streak + 1);
    const until = now + admissionRetryDelaySeconds(streak + 1, retryAfterSeconds, this.random(), this.policy) * 1000;
    const key = `${provider}\0${window}`;
    const cooldown = Math.max(until, this.cooldowns.get(key) ?? 0);
    this.cooldowns.set(key, cooldown);
    return cooldown;
  }

  reportLeaseRateLimit(jobId: string, retryAfterSeconds?: number, now = Date.now()): number | undefined {
    const lease = this.leases.get(jobId);
    if (!lease) return undefined;
    this.leases.delete(jobId);
    const streak = (this.failures.get(lease.provider) ?? 0) + 1;
    this.failures.set(lease.provider, streak);
    const until = now + admissionRetryDelaySeconds(streak, retryAfterSeconds, this.random(), this.policy) * 1000;
    const windows = Object.keys(lease.windowCosts);
    for (const window of windows.length ? windows : ['default']) {
      const key = `${lease.provider}\0${window}`;
      this.cooldowns.set(key, Math.max(until, this.cooldowns.get(key) ?? 0));
    }
    return until;
  }

  reevaluate(
    profiles: ReadonlyMap<string, SubscriptionCapacityProfile>,
    options: { now?: number; force?: boolean; unknownMode?: UnknownCapacityMode } = {},
  ): Array<{ jobId: string; result: AdmissionResult }> {
    const now = options.now ?? Date.now();
    this.expire(now);
    const jobs = [...this.deferred.values()].sort((a, b) =>
      effectiveAdmissionPriority(b.priority, b.enqueuedAt, now, this.policy.agingPerHour)
      - effectiveAdmissionPriority(a.priority, a.enqueuedAt, now, this.policy.agingPerHour));
    const outcomes: Array<{ jobId: string; result: AdmissionResult }> = [];
    for (const job of jobs) {
      if (!options.force && job.notBefore !== undefined && job.notBefore > now) continue;
      if (options.force) job.notBefore = undefined;
      const result = this.admit(job.jobId, job.candidates, profiles, { now, unknownMode: options.unknownMode, priority: job.priority });
      outcomes.push({ jobId: job.jobId, result });
    }
    return outcomes;
  }

  snapshot(now = Date.now()): QuotaAdmissionSnapshot {
    this.expire(now);
    return {
      schemaVersion: 1,
      leases: [...this.leases.values()].map((lease) => ({ ...lease, windowCosts: { ...lease.windowCosts } })),
      deferred: [...this.deferred.values()].map((job) => ({ ...job, candidates: job.candidates.map((candidate) => ({ ...candidate, estimatedCost: { ...candidate.estimatedCost } })) })),
      cooldowns: [...this.cooldowns].map(([key, until]) => { const [provider, window] = key.split('\0'); return { provider: provider!, window: window!, until }; }),
      failures: Object.fromEntries(this.failures),
    };
  }

  private restore(snapshot: QuotaAdmissionSnapshot): void {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.leases) || !Array.isArray(snapshot.deferred)) {
      throw new TypeError('invalid quota admission snapshot');
    }
    for (const lease of snapshot.leases) if (lease.jobId && lease.expiresAt > Date.now()) this.leases.set(lease.jobId, lease);
    for (const job of snapshot.deferred) if (job.jobId) this.deferred.set(job.jobId, job);
    for (const item of snapshot.cooldowns ?? []) if (item.provider && item.window && Number.isFinite(item.until)) this.cooldowns.set(`${item.provider}\0${item.window}`, item.until);
    for (const [provider, count] of Object.entries(snapshot.failures ?? {})) if (Number.isInteger(count) && count >= 0) this.failures.set(provider, count);
  }
}

const CLOCK_DRIFT_MS = 120_000;
const DEFAULT_STALENESS_SECONDS = 900;
const UNKNOWN_PROBE_LIMIT = 1;
const SEVERITY: Record<CapacityState, number> = {
  available: 0, constrained: 1, unknown: 2, stale: 2, exhausted: 3, disabled: 4,
};

function validNonNegative(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function effectiveRemaining(window: CapacityWindow, now: number): number | undefined {
  const resetAt = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
  if (Number.isFinite(resetAt) && now >= resetAt + CLOCK_DRIFT_MS && validNonNegative(window.limit)) {
    return window.limit;
  }
  return validNonNegative(window.remaining) ? window.remaining : undefined;
}

export function evaluateCapacityWindow(window: CapacityWindow, now: number): CapacityState {
  const resetAt = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
  const resetApplied = Number.isFinite(resetAt) && now >= resetAt + CLOCK_DRIFT_MS && validNonNegative(window.limit);
  const remaining = effectiveRemaining(window, now);
  if (!resetApplied) {
    const observedAt = window.observedAt ? Date.parse(window.observedAt) : Number.NaN;
    if (!Number.isFinite(observedAt) || remaining === undefined) return 'unknown';
    const staleAfter = (validNonNegative(window.stalenessSeconds) && window.stalenessSeconds > 0
      ? window.stalenessSeconds : DEFAULT_STALENESS_SECONDS) * 1000;
    if (now - observedAt > staleAfter + CLOCK_DRIFT_MS) return 'stale';
  }
  if (remaining === undefined) return 'unknown';
  if (remaining <= 0) return 'exhausted';
  if (validNonNegative(window.limit) && window.limit > 0 && remaining / window.limit <= 0.2) return 'constrained';
  return 'available';
}

export function evaluateCapacityProfile(profile: SubscriptionCapacityProfile, now: number): CapacityState {
  if (!profile.enabled) return 'disabled';
  if (profile.windows.length === 0) return 'unknown';
  return profile.windows.map((window) => evaluateCapacityWindow(window, now))
    .reduce((worst, state) => SEVERITY[state] > SEVERITY[worst] ? state : worst, 'available');
}

/** Evaluate one candidate. The caller owns the atomic reservation and should re-read snapshots
 * under its lock before committing an admitted result. */
export function evaluateCandidateAdmission(
  profile: SubscriptionCapacityProfile,
  candidate: CapacityCandidate,
  context: AdmissionContext,
): AdmissionResult {
  const state = evaluateCapacityProfile(profile, context.now);
  if (!profile.enabled || state === 'disabled') return { status: 'ineligible', reason: 'profile-disabled', state };
  if (profile.id !== candidate.profileId || profile.provider !== candidate.provider) {
    return { status: 'ineligible', reason: 'profile-provider-mismatch', state };
  }
  if (!profile.allowedModelIds.includes(candidate.modelId)) {
    return { status: 'ineligible', reason: 'model-not-allowed', state };
  }
  const active = context.activeByProfile[profile.id] ?? 0;
  if (active >= profile.maxConcurrency) {
    const releases = [...(context.activeReleaseAtByProfile?.[profile.id] ?? [])].sort((a, b) => a - b);
    const needed = active - profile.maxConcurrency + 1;
    return { status: 'deferred', reason: 'concurrency-limit', retryAt: releases[needed - 1], state };
  }
  const windows = new Map(profile.windows.map((window) => [window.name, window]));
  for (const name of Object.keys(candidate.estimatedCost)) {
    if (!windows.has(name)) return { status: 'ineligible', reason: `unknown-window:${name}`, state };
  }
  let retryAt: number | undefined;
  const windowCosts: Record<string, number> = {};
  for (const window of profile.windows) {
    const name = window.name;
    const cost = candidate.estimatedCost[name] ?? 1;
    if (!validNonNegative(cost)) return { status: 'ineligible', reason: `invalid-estimate:${name}`, state };
    windowCosts[name] = cost;
    const remaining = effectiveRemaining(window, context.now);
    const observedAt = window.observedAt ? Date.parse(window.observedAt) : Number.NaN;
    const isFresh = Number.isFinite(observedAt)
      && context.now - observedAt <= ((window.stalenessSeconds ?? DEFAULT_STALENESS_SECONDS) * 1000 + CLOCK_DRIFT_MS);
    if (remaining === undefined || !isFresh) {
      if (context.unknownMode === 'conservative') {
        const reset = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
        if (Number.isFinite(reset)) retryAt = retryAt === undefined ? reset : Math.min(retryAt, reset);
        return { status: 'deferred', reason: `capacity-${remaining === undefined ? 'unknown' : 'stale'}:${name}`, retryAt, state };
      }
      const probes = context.unknownProbeByProfile?.[profile.id] ?? 0;
      const probeLimit = context.optimisticUnknownLimit ?? UNKNOWN_PROBE_LIMIT;
      if (probes >= probeLimit) return { status: 'deferred', reason: `unknown-probe-limit:${name}`, state };
      continue;
    }
    const reserved = context.reservedByProfileAndWindow[profile.id]?.[name] ?? 0;
    if (remaining <= 0 || remaining - reserved < cost) {
      const reset = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
      let leaseRetry: number | undefined;
      let recovered = 0;
      const needed = Math.max(0, cost - (remaining - reserved));
      for (const release of [...(context.reservedReleaseSchedule?.[profile.id]?.[name] ?? [])].sort((a, b) => a.at - b.at)) {
        recovered += release.cost;
        if (recovered >= needed) { leaseRetry = release.at; break; }
      }
      const resetRetry = Number.isFinite(reset) ? reset + CLOCK_DRIFT_MS : undefined;
      const candidateRetry = leaseRetry === undefined ? resetRetry
        : resetRetry === undefined ? leaseRetry : Math.min(leaseRetry, resetRetry);
      if (candidateRetry !== undefined) retryAt = retryAt === undefined ? candidateRetry : Math.min(retryAt, candidateRetry);
      return { status: 'deferred', reason: `capacity-exhausted:${name}`, retryAt, state: 'exhausted' };
    }
  }
  return {
    status: 'admitted',
    reservation: { profileId: profile.id, provider: profile.provider, modelId: candidate.modelId, windowCosts },
    state,
  };
}

/** Try the caller's deterministic routing order. Pinned work supplies exactly one candidate;
 * unpinned work may supply its explicitly permitted fallbacks. */
export function evaluateCandidatesAdmission(
  profiles: ReadonlyMap<string, SubscriptionCapacityProfile>,
  candidates: readonly CapacityCandidate[],
  context: AdmissionContext,
): RoutedAdmissionResult {
  const rejections: RoutedAdmissionResult['rejections'] = [];
  let earliestRetry: number | undefined;
  let allDeferred = candidates.length > 0;
  let mostConstrained: CapacityState = 'unknown';
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]!;
    const profile = profiles.get(candidate.profileId);
    if (!profile) {
      allDeferred = false;
      rejections.push({ candidateIndex, status: 'ineligible', reason: 'unknown-profile' });
      continue;
    }
    const result = evaluateCandidateAdmission(profile, candidate, context);
    if (result.status === 'admitted') {
      return { result, candidate, candidateIndex, rejections };
    }
    if (result.status === 'ineligible') allDeferred = false;
    else if (result.retryAt !== undefined) earliestRetry = earliestRetry === undefined
      ? result.retryAt : Math.min(earliestRetry, result.retryAt);
    if (SEVERITY[result.state] > SEVERITY[mostConstrained]) mostConstrained = result.state;
    rejections.push({ candidateIndex, status: result.status, reason: result.reason });
  }
  const reason = candidates.length === 0
    ? 'no-routing-candidates'
    : allDeferred ? 'all-candidates-capacity-deferred' : 'no-eligible-candidate';
  const result: AdmissionResult = allDeferred
    ? { status: 'deferred', reason, retryAt: earliestRetry, state: mostConstrained }
    : { status: 'ineligible', reason, state: mostConstrained };
  return { result, rejections };
}
