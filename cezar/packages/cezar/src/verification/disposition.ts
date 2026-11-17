import { createHash } from 'node:crypto';
import {
  dispositionSchema,
  waiverSchema,
  type DispositionClass,
  type DispositionRecord,
  type WaiverRecord,
} from './disposition-schema.ts';
import type { FindingAuditLog } from './finding-ingest.ts';
import type { FindingLedgerStore } from './finding-ledger.ts';

/**
 * Per-run dispositions: a pure, deterministic comparison of one run's findings against a
 * TRUSTED baseline. Occurrences stay immutable observations and Findings/Episodes stay
 * persistent; a Disposition is the separate per-run decision. Time only ever comes from
 * the run / baseline event data, never the wall clock, so replay is byte-identical.
 *
 * Safety direction: anything that cannot be compared with confidence (no trusted baseline,
 * changed environment, stale evidence, missing suite, incomplete selection, runner crash)
 * yields `unknown` / `untested` / `infra-failure`, which are blocking and never a pass.
 */

export interface DispositionPolicy {
  version: number;
  /** Branches whose runs may become a trusted baseline (never the run's own branch). */
  integrationBranches: string[];
  /** Environment keys that make up the comparable environment fingerprint. */
  environmentKeys: string[];
  maxBaselineAgeDays: number;
  waiverMaxTtlDays: number;
  /** policies/baseline-promotion.json permittedApprovers: approved evidence and waiver authority. */
  approvers: string[];
}

export interface FindingObservation {
  fingerprint: string;
  /** The suite/check that reports it; used for coverage completeness. */
  checkId: string;
  count: number;
}

export interface TrustedBaselineCandidate {
  id: string;
  branch: string;
  commitSha: string;
  source: 'integration' | 'approved-evidence';
  approvedBy?: string;
  environment: Record<string, string>;
  suites: string[];
  observedAt: string;
  findings: FindingObservation[];
  evidenceRefs?: string[];
}

export interface RunObservation {
  projectId: string;
  runId: string;
  branch: string;
  commitSha: string;
  /** Who produced the run; may never be the authority of a waiver covering it. */
  author: string;
  environment: Record<string, string>;
  requiredSuites: string[];
  executedSuites: string[];
  /** False when test selection or coverage was incomplete. */
  selectionComplete: boolean;
  runStatus: 'completed' | 'crashed' | 'timeout' | 'cancelled';
  observedAt: string;
  findings: FindingObservation[];
  evidenceRefs?: string[];
}

export interface DispositionInput {
  run: RunObservation;
  baselines: TrustedBaselineCandidate[];
  /** Fingerprints whose latest Episode is resolved; a return of one of these is `reopened`. */
  resolvedFingerprints?: string[];
  waivers?: WaiverRecord[];
  policy: DispositionPolicy;
  actor?: string;
}

export interface DispositionResult {
  status: 'comparable' | 'unknown' | 'infra-failure';
  baseline: { id: string; commitSha: string } | null;
  rejectedBaselines: { id: string; reason: string }[];
  dispositions: DispositionRecord[];
  /** True only when comparable and nothing blocking remains. Never true for unknown/infra. */
  passable: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const BLOCKING: ReadonlySet<DispositionClass> = new Set(['new', 'worsened', 'reopened', 'untested', 'unknown', 'infra-failure']);
const WAIVABLE: ReadonlySet<DispositionClass> = new Set(['new', 'worsened', 'reopened']);

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Digest of the comparable environment keys only; missing keys are part of the identity. */
export function environmentFingerprint(environment: Record<string, string>, keys: readonly string[]): string {
  const selected: Record<string, string | null> = {};
  for (const key of [...keys].sort()) selected[key] = environment[key] ?? null;
  return sha256(canonical(selected));
}

/**
 * Pick the baseline a run may be compared against. Only integration-branch evidence (not
 * from the run's own branch or commit) or evidence approved by a promotion approver who is
 * not the run author is trusted. Feature-branch reruns therefore can never become the
 * baseline, so a new failure cannot turn "known" by being re-reported.
 */
export function resolveTrustedBaseline(
  candidates: readonly TrustedBaselineCandidate[],
  run: RunObservation,
  policy: DispositionPolicy,
): { baseline: TrustedBaselineCandidate | null; rejected: { id: string; reason: string }[] } {
  const rejected: { id: string; reason: string }[] = [];
  const trusted: TrustedBaselineCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const reject = (reason: string) => rejected.push({ id: candidate.id, reason });
    if (candidate.commitSha === run.commitSha) { reject('baseline is the run itself'); continue; }
    if (candidate.source === 'integration') {
      if (!policy.integrationBranches.includes(candidate.branch)) { reject(`branch ${candidate.branch} is not an integration branch`); continue; }
      if (candidate.branch === run.branch && !policy.integrationBranches.includes(run.branch)) { reject('baseline from the run branch'); continue; }
    } else if (!candidate.approvedBy || !policy.approvers.includes(candidate.approvedBy) || candidate.approvedBy === run.author) {
      reject('approved evidence lacks an independent permitted approver');
      continue;
    }
    const age = Date.parse(run.observedAt) - Date.parse(candidate.observedAt);
    if (age < 0) { reject('baseline is newer than the run'); continue; }
    if (age > policy.maxBaselineAgeDays * DAY_MS) { reject('baseline evidence is stale'); continue; }
    trusted.push(candidate);
  }
  trusted.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || (a.id < b.id ? -1 : 1));
  return { baseline: trusted[0] ?? null, rejected };
}

/** A waiver is valid for a disposition only when scoped, unexpired and independently authorised. */
export function waiverIsActive(waiver: WaiverRecord, run: RunObservation, fingerprint: string, policy: DispositionPolicy): boolean {
  if (waiver.fingerprint !== fingerprint) return false;
  if (!waiver.branches.includes(run.branch)) return false;
  if (!policy.approvers.includes(waiver.grantedBy) || waiver.grantedBy === run.author) return false;
  const at = Date.parse(run.observedAt);
  if (!(Date.parse(waiver.grantedAt) <= at && at < Date.parse(waiver.expiresAt))) return false;
  return Date.parse(waiver.expiresAt) - Date.parse(waiver.grantedAt) <= policy.waiverMaxTtlDays * DAY_MS;
}

export function normalizeDispositions(input: DispositionInput): DispositionResult {
  const { run, policy } = input;
  const actor = input.actor ?? 'verification-normalizer';
  const envFp = environmentFingerprint(run.environment, policy.environmentKeys);
  const { baseline, rejected } = resolveTrustedBaseline(input.baselines, run, policy);
  const out: DispositionRecord[] = [];

  const make = (
    disposition: DispositionClass, fingerprint: string | null, checkId: string | null, reason: string,
    waiverId: string | null = null,
  ): void => {
    const waived = waiverId !== null;
    out.push(dispositionSchema.parse({
      id: sha256(canonical([run.projectId, run.runId, fingerprint, checkId, disposition, policy.version])),
      projectId: run.projectId, runId: run.runId, fingerprint, checkId, disposition,
      decision: BLOCKING.has(disposition) && !waived ? 'blocking' : 'non-blocking',
      reason, evidenceRefs: [...(run.evidenceRefs ?? [])].sort(), policyVersion: policy.version,
      baseSha: baseline?.commitSha ?? null, environmentFingerprint: envFp, actor, at: run.observedAt, waiverId,
    }));
  };
  const finish = (status: DispositionResult['status']): DispositionResult => {
    out.sort((a, b) => cmp(a.fingerprint ?? '', b.fingerprint ?? '') || cmp(a.checkId ?? '', b.checkId ?? '') || cmp(a.id, b.id));
    const passable = status === 'comparable' && out.every((record) => record.decision === 'non-blocking');
    return {
      status, baseline: baseline ? { id: baseline.id, commitSha: baseline.commitSha } : null,
      rejectedBaselines: rejected, dispositions: out, passable,
    };
  };
  const observed = dedupe(run.findings);

  if (run.runStatus !== 'completed') {
    make('infra-failure', null, null, `runner ${run.runStatus}; results are not evidence`);
    return finish('infra-failure');
  }
  if (!baseline) {
    make('unknown', null, null, `no trusted baseline: ${rejected.map((item) => `${item.id}: ${item.reason}`).join('; ') || 'none supplied'}`);
    for (const item of observed) make('unknown', item.fingerprint, item.checkId, 'cannot classify without a trusted baseline');
    return finish('unknown');
  }
  if (environmentFingerprint(baseline.environment, policy.environmentKeys) !== envFp) {
    make('unknown', null, null, 'environment fingerprint differs from the trusted baseline');
    for (const item of observed) make('unknown', item.fingerprint, item.checkId, 'environment differs from the baseline');
    return finish('unknown');
  }

  const executed = new Set(run.executedSuites);
  const missing = [...new Set(run.requiredSuites)].filter((suite) => !executed.has(suite)).sort();
  const complete = missing.length === 0 && run.selectionComplete;
  if (missing.length) make('unknown', null, null, `required suite not run: ${missing.join(', ')}`);
  else if (!run.selectionComplete) make('unknown', null, null, 'test selection or coverage incomplete');

  const base = new Map(dedupe(baseline.findings).map((item) => [item.fingerprint, item]));
  const resolved = new Set(input.resolvedFingerprints ?? []);
  const waiverFor = (fingerprint: string): string | null => {
    const match = (input.waivers ?? []).filter((waiver) => waiverIsActive(waiver, run, fingerprint, policy)).map((w) => w.id).sort()[0];
    return match ?? null;
  };
  const seen = new Set<string>();
  for (const item of observed) {
    seen.add(item.fingerprint);
    const prior = base.get(item.fingerprint);
    let disposition: DispositionClass;
    let reason: string;
    if (prior) {
      disposition = item.count > prior.count ? 'worsened' : 'known';
      reason = disposition === 'worsened' ? `count rose from ${prior.count} to ${item.count}` : 'present in the trusted baseline';
    } else if (resolved.has(item.fingerprint)) {
      disposition = 'reopened'; reason = 'previously resolved finding reproduced';
    } else {
      disposition = 'new'; reason = 'absent from the trusted baseline';
    }
    make(disposition, item.fingerprint, item.checkId, reason, WAIVABLE.has(disposition) ? waiverFor(item.fingerprint) : null);
  }
  for (const item of base.values()) {
    if (seen.has(item.fingerprint)) continue;
    if (!complete || !executed.has(item.checkId)) make('untested', item.fingerprint, item.checkId, 'baseline finding not covered by this run; absence is not resolution');
    else make('resolved', item.fingerprint, item.checkId, 'covered by a complete run and no longer reported');
  }
  return finish(complete ? 'comparable' : 'unknown');
}

/** Persist a result: every disposition in the ledger store plus one audit event for the run. */
export function recordDispositions(
  store: FindingLedgerStore, audit: FindingAuditLog, result: DispositionResult, policy: DispositionPolicy,
): void {
  const first = result.dispositions[0];
  if (!first) return;
  for (const record of result.dispositions) store.appendDisposition(record);
  const counts: Record<string, number> = {};
  for (const record of result.dispositions) counts[record.disposition] = (counts[record.disposition] ?? 0) + 1;
  if (audit.state().dispositionRuns[first.runId]) return; // idempotent replay of the same run
  audit.append({
    type: 'disposition-recorded', projectId: first.projectId, at: first.at, actor: first.actor,
    reason: `${result.status}; baseline ${result.baseline?.id ?? 'none'}`, runId: first.runId, counts,
    policyVersion: policy.version, prior: null,
  });
}

export interface WaiverRequest {
  id: string;
  fingerprint: string;
  branches: string[];
  reason: string;
  requestedBy: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
}

/** Record a waiver only if scoped, expiring and granted by an independent permitted authority. */
export function grantWaiver(
  store: FindingLedgerStore, audit: FindingAuditLog, request: WaiverRequest, policy: DispositionPolicy,
): WaiverRecord {
  if (!policy.approvers.includes(request.grantedBy)) throw new Error('waiver authority is not a permitted approver');
  if (request.grantedBy === request.requestedBy) throw new Error('waiver authority must be independent of the requester');
  if (request.branches.some((branch) => branch.includes('*'))) throw new Error('waiver branch scope cannot be a wildcard');
  const ttl = Date.parse(request.expiresAt) - Date.parse(request.grantedAt);
  if (!(ttl > 0)) throw new Error('waiver must expire after it is granted');
  if (ttl > policy.waiverMaxTtlDays * DAY_MS) throw new Error(`waiver ttl exceeds the ${policy.waiverMaxTtlDays} day maximum`);
  const record = waiverSchema.parse({
    id: request.id, projectId: store.projectId, fingerprint: request.fingerprint, branches: [...request.branches].sort(),
    reason: request.reason, grantedBy: request.grantedBy, grantedAt: request.grantedAt, expiresAt: request.expiresAt,
    policyVersion: policy.version,
  });
  const stored = store.appendWaiver(record);
  if (!audit.state().waivers[stored.id]) {
    audit.append({
      type: 'waiver-granted', projectId: store.projectId, at: stored.grantedAt, actor: stored.grantedBy,
      reason: stored.reason, waiverId: stored.id, fingerprint: stored.fingerprint, expiresAt: stored.expiresAt, prior: null,
    });
  }
  return stored;
}

/** Fingerprints whose latest episode is resolved, for the `reopened` class. */
export function resolvedFingerprints(store: FindingLedgerStore): string[] {
  const snapshot = store.snapshot();
  const byId = new Map(snapshot.findings.map((finding) => [finding.id, finding.fingerprint]));
  const latest = new Map<string, { status: string; at: string }>();
  for (const episode of snapshot.episodes) {
    const prior = latest.get(episode.findingId);
    if (!prior || Date.parse(episode.openedAt) >= Date.parse(prior.at)) latest.set(episode.findingId, { status: episode.status, at: episode.openedAt });
  }
  return [...latest].filter(([, value]) => value.status === 'resolved').map(([id]) => byId.get(id)!).filter(Boolean).sort();
}

/** Parse policies/verification.json `dispositions` plus baseline-promotion approvers. */
export function loadDispositionPolicy(verification: unknown, promotion: unknown): DispositionPolicy {
  const section = (verification as { dispositions?: Record<string, unknown> } | null)?.dispositions;
  const approvers = (promotion as { permittedApprovers?: unknown } | null)?.permittedApprovers;
  if (!section || !Array.isArray(approvers)) throw new Error('disposition policy and permitted approvers are required');
  const waiver = (section.waiver ?? {}) as { maxTtlDays?: unknown };
  const strings = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item)) throw new Error(`disposition policy ${name} must be a non-empty string list`);
    return value as string[];
  };
  const positive = (value: unknown, name: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`disposition policy ${name} must be positive`);
    return value;
  };
  return {
    version: positive(section.policyVersion, 'policyVersion'),
    integrationBranches: strings(section.integrationBranches, 'integrationBranches'),
    environmentKeys: strings(section.environmentKeys, 'environmentKeys'),
    maxBaselineAgeDays: positive(section.maxBaselineAgeDays, 'maxBaselineAgeDays'),
    waiverMaxTtlDays: positive(waiver.maxTtlDays, 'waiver.maxTtlDays'),
    approvers: strings(approvers, 'permittedApprovers'),
  };
}

function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Merge duplicate fingerprints (summing counts) so input order never matters. */
function dedupe(items: readonly FindingObservation[]): FindingObservation[] {
  const merged = new Map<string, FindingObservation>();
  for (const item of items) {
    const prior = merged.get(item.fingerprint);
    merged.set(item.fingerprint, prior ? { ...prior, count: prior.count + item.count } : { ...item });
  }
  return [...merged.values()].sort((a, b) => cmp(a.fingerprint, b.fingerprint));
}
