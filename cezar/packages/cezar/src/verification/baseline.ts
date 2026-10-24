import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import type { VerificationRun } from '@open-mercato/cezar-contract';
import type { FindingOccurrence } from './finding-ledger.ts';
import type { VerificationSelection } from './selection.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

export const BASELINE_KINDS = ['accepted-debt', 'branch-comparison', 'controlled-performance'] as const;
export type BaselineKind = typeof BASELINE_KINDS[number];

const knownFailureSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), checkId: z.string().min(1), state: z.enum(['accepted', 'resolved']), firstSeenAt: z.string().datetime() }).strict();
const performanceSchema = z.object({ checkId: z.string().min(1), name: z.string().min(1), value: z.number().finite(), unit: z.string().max(64).optional(), allowedRegressionPercent: z.number().min(0).max(10_000) }).strict();
const approvalSchema = z.object({ actor: z.string().min(1).max(256), role: z.enum(['owner', 'reviewer']), reference: z.string().min(1).max(512), approvedAt: z.string().datetime() }).strict();

export const verificationBaselineSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), projectId: z.string().min(1), kind: z.enum(BASELINE_KINDS),
  sourceRunId: z.string().min(1), sourceVerificationId: z.string().min(1), commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(), environment: z.object({ platform: z.string().min(1), toolsDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  mandatoryCheckIds: z.array(z.string().min(1)).max(256), knownFailures: z.array(knownFailureSchema).max(100_000),
  performance: z.array(performanceSchema).max(10_000), approval: approvalSchema.optional(),
}).strict();
export type VerificationBaseline = z.infer<typeof verificationBaselineSchema>;
export type VerificationBaselineCandidate = Omit<VerificationBaseline, 'approval'>;

const auditSchema = z.object({ id: z.string().uuid(), kind: z.enum(['baseline-promoted', 'comparison-recorded']), projectId: z.string().min(1), actor: z.string().min(1), at: z.string().datetime(), previousRevision: z.string().nullable(), revision: z.string(), reference: z.string().min(1), runId: z.string().optional(), reportDigest: z.string().optional() }).strict();
type BaselineAudit = z.infer<typeof auditSchema>;
const fileSchema = z.object({ version: z.literal(1), projectId: z.string().min(1), baseline: verificationBaselineSchema.optional(), audit: z.array(auditSchema).max(100_000) }).strict();
type BaselineFile = z.infer<typeof fileSchema>;

export const verificationPolicySchema = z.object({
  version: z.literal(1),
  development: z.object({ minimumCoveragePercent: z.number().min(0).max(100), blockOn: z.array(z.enum(['new', 'worsening', 'reopened'])) }).strict(),
  release: z.object({ minimumCoveragePercent: z.literal(100), requireFullSelection: z.literal(true), allowKnownDebt: z.literal(false), maxKnownDebt: z.literal(0) }).strict(),
}).strict();
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = verificationPolicySchema.parse({
  version: 1,
  development: { minimumCoveragePercent: 70, blockOn: ['new', 'worsening', 'reopened'] },
  release: { minimumCoveragePercent: 100, requireFullSelection: true, allowKnownDebt: false, maxKnownDebt: 0 },
});

export type BaselineOutcomeKind = 'new' | 'known' | 'fixed' | 'worsening' | 'reopened' | 'untested' | 'infrastructure-inconclusive';
export interface BaselineOutcome { kind: BaselineOutcomeKind; checkId: string; fingerprint?: string; detail: string }
export interface BaselineComparison {
  version: 1; projectId: string; runId: string; verificationId: string; commitSha: string; baselineRevision: string;
  mode: 'development' | 'release'; coveragePercent: number; requiredChecks: number; testedRequiredChecks: number;
  outcomes: BaselineOutcome[]; counts: Record<BaselineOutcomeKind, number>;
  developmentProgressAllowed: boolean; verificationGreen: boolean; releaseReady: boolean; reasons: string[];
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function baselineRevision(baseline: VerificationBaseline): string { return hash(canonical(baseline)); }
function toolsDigest(run: VerificationRun): string { return hash(canonical(run.toolVersions)); }

export function createBaselineCandidate(input: {
  run: VerificationRun;
  kind: BaselineKind;
  mandatoryCheckIds: string[];
  knownOccurrences?: FindingOccurrence[];
  expiresAt: string;
  allowedRegressionPercent?: number;
}): VerificationBaselineCandidate {
  const run = input.run;
  const knownFailures = new Map<string, VerificationBaseline['knownFailures'][number]>();
  for (const occurrence of input.knownOccurrences ?? []) {
    if (occurrence.verificationId !== run.verificationId) continue;
    knownFailures.set(occurrence.fingerprint, { fingerprint: occurrence.fingerprint, checkId: occurrence.checkId, state: 'accepted', firstSeenAt: occurrence.firstSeenAt });
  }
  const candidate = verificationBaselineSchema.omit({ approval: true }).parse({
    version: 1, id: randomUUID(), projectId: run.projectId, kind: input.kind, sourceRunId: run.cezarRunId,
    sourceVerificationId: run.verificationId, commitSha: run.commitSha, createdAt: run.finishedAt, expiresAt: input.expiresAt,
    environment: { platform: run.environment.platform ?? process.platform, toolsDigest: toolsDigest(run) },
    mandatoryCheckIds: [...new Set(input.mandatoryCheckIds)].sort(), knownFailures: [...knownFailures.values()],
    performance: input.kind === 'controlled-performance' ? run.checks.flatMap((check) => check.metrics.map((metric) => ({ checkId: check.checkId, name: metric.name, value: metric.value, ...(metric.unit ? { unit: metric.unit } : {}), allowedRegressionPercent: input.allowedRegressionPercent ?? 5 }))) : [],
  });
  return candidate;
}

export function compareVerification(input: {
  run: VerificationRun;
  selection: VerificationSelection;
  baseline: VerificationBaseline;
  occurrences: FindingOccurrence[];
  mode: 'development' | 'release';
  policy?: VerificationPolicy;
  now?: Date;
}): BaselineComparison {
  const run = input.run;
  const policy = input.policy ?? DEFAULT_VERIFICATION_POLICY;
  const baseline = verificationBaselineSchema.parse(input.baseline);
  if (run.projectId !== baseline.projectId) throw new Error('baseline belongs to a different project');
  const revision = baselineRevision(baseline);
  const outcomes: BaselineOutcome[] = [];
  const findings = new Map<string, FindingOccurrence>();
  for (const occurrence of input.occurrences) if (occurrence.verificationId === run.verificationId) findings.set(occurrence.fingerprint, occurrence);
  const baselineByFingerprint = new Map(baseline.knownFailures.map((item) => [item.fingerprint, item]));
  const expired = Date.parse(baseline.expiresAt) <= (input.now ?? new Date()).getTime();
  const staleBranch = baseline.kind === 'branch-comparison' && (!run.baseSha || run.baseSha !== baseline.commitSha);
  const environmentMismatch = baseline.kind === 'controlled-performance' && (baseline.environment.platform !== (run.environment.platform ?? process.platform) || baseline.environment.toolsDigest !== toolsDigest(run));
  const selectionMap = new Map(input.selection.checks.map((check) => [check.checkId, check]));
  const selectedIds = new Set(input.selection.checks.filter((check) => check.status === 'selected').map((check) => check.checkId));

  for (const check of run.checks) {
    if (check.status === 'not-selected') continue;
    if (['unknown', 'infrastructure-error', 'cancelled', 'no-tests', 'skipped'].includes(check.status) || check.outputTruncated) {
      outcomes.push({ kind: 'infrastructure-inconclusive', checkId: check.checkId, detail: `check status ${check.status} does not prove pass or failure` });
      continue;
    }
    if (check.status !== 'failed') continue;
    const matches = [...findings.values()].filter((item) => item.checkId === check.checkId);
    if (!matches.length) outcomes.push({ kind: 'infrastructure-inconclusive', checkId: check.checkId, detail: 'failed check has no fingerprinted finding evidence' });
    for (const occurrence of matches) {
      const prior = baselineByFingerprint.get(occurrence.fingerprint);
      const kind: BaselineOutcomeKind = prior?.state === 'resolved' ? 'reopened' : prior ? 'known' : 'new';
      outcomes.push({ kind, checkId: check.checkId, fingerprint: occurrence.fingerprint, detail: prior ? `failure is ${prior.state} in baseline` : 'fingerprint is absent from approved baseline' });
    }
  }

  for (const prior of baseline.knownFailures) {
    if ([...findings.keys()].includes(prior.fingerprint)) continue;
    const selected = selectedIds.has(prior.checkId);
    const check = run.checks.find((item) => item.checkId === prior.checkId);
    if (!selected || !check || check.status === 'not-selected') {
      outcomes.push({ kind: 'untested', checkId: prior.checkId, fingerprint: prior.fingerprint, detail: 'relevant passing coverage was not selected or omitted' });
    } else if (check.status === 'passed' && !check.outputTruncated && check.coverage.selected === 1 && check.coverage.passed === 1) {
      outcomes.push({ kind: 'fixed', checkId: prior.checkId, fingerprint: prior.fingerprint, detail: 'relevant complete passing coverage did not reproduce the baseline failure' });
    } else if (['unknown', 'infrastructure-error', 'cancelled', 'no-tests', 'skipped'].includes(check.status) || check.outputTruncated) {
      outcomes.push({ kind: 'infrastructure-inconclusive', checkId: prior.checkId, fingerprint: prior.fingerprint, detail: `baseline failure could not be evaluated (${check.status})` });
    } else {
      outcomes.push({ kind: 'untested', checkId: prior.checkId, fingerprint: prior.fingerprint, detail: 'check failed without reproducing this baseline fingerprint' });
    }
  }

  if (baseline.kind === 'controlled-performance') {
    if (environmentMismatch) outcomes.push({ kind: 'infrastructure-inconclusive', checkId: '*', detail: 'controlled performance baseline platform or tool versions differ' });
    else for (const metric of baseline.performance) {
      const selected = selectedIds.has(metric.checkId);
      const check = run.checks.find((item) => item.checkId === metric.checkId);
      const observed = check?.metrics.find((item) => item.name === metric.name && item.unit === metric.unit);
      if (!selected || !check || !observed) outcomes.push({ kind: 'untested', checkId: metric.checkId, detail: `performance metric ${metric.name} was not measured` });
      else if (observed.value > metric.value * (1 + metric.allowedRegressionPercent / 100)) outcomes.push({ kind: 'worsening', checkId: metric.checkId, detail: `${metric.name} increased from ${metric.value} to ${observed.value}${metric.unit ?? ''}` });
    }
  }

  if (expired) outcomes.push({ kind: 'infrastructure-inconclusive', checkId: '*', detail: 'approved baseline has expired' });
  if (staleBranch) outcomes.push({ kind: 'infrastructure-inconclusive', checkId: '*', detail: 'branch comparison baseline commit does not match run base SHA' });
  if (baseline.kind === 'controlled-performance' && input.mode === 'development' && environmentMismatch) {
    // The finding remains in the report; no cross-platform performance verdict is inferred.
  }

  const counts = Object.fromEntries((['new', 'known', 'fixed', 'worsening', 'reopened', 'untested', 'infrastructure-inconclusive'] as BaselineOutcomeKind[]).map((kind) => [kind, outcomes.filter((item) => item.kind === kind).length])) as Record<BaselineOutcomeKind, number>;
  const requiredIds = new Set(baseline.mandatoryCheckIds);
  const requiredChecks = requiredIds.size;
  const testedRequiredChecks = [...requiredIds].filter((id) => {
    const check = run.checks.find((item) => item.checkId === id);
    return !!check && selectedIds.has(id) && ['passed', 'failed'].includes(check.status) && !check.outputTruncated;
  }).length;
  const coveragePercent = requiredChecks ? Math.floor((testedRequiredChecks / requiredChecks) * 100) : 0;
  const developmentProgressAllowed = coveragePercent >= policy.development.minimumCoveragePercent
    && policy.development.blockOn.every((kind) => counts[kind] === 0)
    && counts['infrastructure-inconclusive'] === 0;
  const unknown = counts.untested > 0 || counts['infrastructure-inconclusive'] > 0 || coveragePercent < policy.development.minimumCoveragePercent;
  const verificationGreen = developmentProgressAllowed && !unknown && counts.known === 0 && run.status === 'passed';
  const fullSelection = input.selection.checks.every((item) => item.status === 'selected');
  const releaseReady = input.mode === 'release' && !expired && !staleBranch && !environmentMismatch && fullSelection && coveragePercent === policy.release.minimumCoveragePercent && counts.known === 0 && counts.new === 0 && counts.worsening === 0 && counts.reopened === 0 && counts.untested === 0 && counts['infrastructure-inconclusive'] === 0 && run.status === 'passed';
  const reasons = outcomes.map((item) => `${item.kind}: ${item.detail}`);
  if (!developmentProgressAllowed) reasons.push('development progress gate is blocked by new regression outcomes or insufficient conclusive coverage');
  if (!verificationGreen) reasons.push('run is not green: known debt, incomplete coverage, infrastructure uncertainty, or a failed run remains');
  if (input.mode === 'release' && !releaseReady) reasons.push('release gate requires full selected coverage and zero unresolved debt or inconclusive evidence');
  return { version: 1, projectId: run.projectId, runId: run.cezarRunId, verificationId: run.verificationId, commitSha: run.commitSha, baselineRevision: revision, mode: input.mode, coveragePercent, requiredChecks, testedRequiredChecks, outcomes, counts, developmentProgressAllowed, verificationGreen, releaseReady, reasons };
}

export interface BaselineApproval { actor: string; role: 'owner' | 'reviewer'; reference: string; approvedAt: string }
export type BaselineAuthorizer = (approval: BaselineApproval) => Promise<boolean>;

/** Owner-side baseline store. Promotion is impossible without an injected authorization check. */
export class VerificationBaselineStore {
  private readonly filePath: string;
  constructor(private readonly dataDir: string, readonly projectId: string, private readonly authorize: BaselineAuthorizer) {
    if (!projectId.trim()) throw new Error('projectId is required');
    this.filePath = join(dataDir, 'verification-baseline.json');
  }

  async current(): Promise<VerificationBaseline | undefined> { return (await this.read()).baseline; }
  async audit(): Promise<BaselineAudit[]> { return (await this.read()).audit; }

  async promote(candidateInput: VerificationBaselineCandidate, approvalInput: BaselineApproval, expectedPreviousRevision: string | null): Promise<{ baseline: VerificationBaseline; revision: string }> {
    const candidate = verificationBaselineSchema.omit({ approval: true }).parse(candidateInput);
    const approval = approvalSchema.parse(approvalInput);
    if (candidate.projectId !== this.projectId) throw new Error('candidate belongs to a different project');
    if (!(await this.authorize(approval))) throw new Error('baseline promotion is not authorized');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.filePath, { realpath: false, stale: 10_000, update: 1_000, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
    try {
      const state = this.readSync();
      const prior = state.baseline ? baselineRevision(state.baseline) : null;
      if (prior !== expectedPreviousRevision) throw new Error('baseline changed since candidate review; reload before promotion');
      const baseline = verificationBaselineSchema.parse({ ...candidate, approval });
      const revision = baselineRevision(baseline);
      state.baseline = baseline;
      state.audit.push({ id: randomUUID(), kind: 'baseline-promoted', projectId: this.projectId, actor: approval.actor, at: approval.approvedAt, previousRevision: prior, revision, reference: approval.reference });
      atomicWriteJsonSync(this.filePath, fileSchema.parse(state));
      return { baseline, revision };
    } finally { await release(); }
  }

  async recordComparison(report: BaselineComparison, actor = 'verification-engine'): Promise<string> {
    if (report.projectId !== this.projectId) throw new Error('comparison belongs to a different project');
    const relativePath = `verification-comparisons/${hash(report.verificationId)}.json`;
    await this.mutate((state) => {
      const reportPath = join(this.dataDir, relativePath);
      mkdirSync(join(this.dataDir, 'verification-comparisons'), { recursive: true, mode: 0o700 });
      atomicWriteJsonSync(reportPath, report);
      state.audit.push({ id: randomUUID(), kind: 'comparison-recorded', projectId: this.projectId, actor, at: new Date().toISOString(), previousRevision: report.baselineRevision, revision: report.baselineRevision, reference: `verification:${report.verificationId}`, runId: report.runId, reportDigest: hash(JSON.stringify(report)) });
    });
    return relativePath;
  }

  private async mutate(fn: (state: BaselineFile) => void): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.filePath, { realpath: false, stale: 10_000, update: 1_000, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
    try { const state = this.readSync(); fn(state); atomicWriteJsonSync(this.filePath, fileSchema.parse(state)); }
    finally { await release(); }
  }

  private async read(): Promise<BaselineFile> {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.filePath, { realpath: false, stale: 10_000, update: 1_000, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
    try { const state = this.readSync(); atomicWriteJsonSync(this.filePath, state); return state; }
    finally { await release(); }
  }

  private readSync(): z.infer<typeof fileSchema> {
    try { return fileSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projectId: this.projectId, audit: [] };
      throw new Error(`verification baseline is corrupt or unsupported: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
