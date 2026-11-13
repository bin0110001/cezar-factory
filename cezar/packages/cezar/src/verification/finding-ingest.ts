import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { VerificationCheckRun, VerificationRun } from '@open-mercato/cezar-contract';
import { verificationFindingKindSchema } from '@open-mercato/cezar-contract';
import { FINGERPRINT_STRATEGIES } from './fingerprint.ts';
import {
  occurrenceFromVerification,
  type EpisodeRecord,
  type FindingLedgerStore,
  type FindingRecord,
} from './finding-ledger.ts';

/**
 * Ingestion, recurrence and resolution semantics plus an append-only audit trail
 * of human overrides, layered on FindingLedgerStore. No GitHub or Hindsight writes.
 *
 * Time comes from the verification result (finishedAt) or the explicit `at` of an
 * override, never the wall clock, so replaying the audit log is deterministic.
 */

export const AUDIT_LOG_FILE = 'verification-ledger-audit.jsonl';

// ---------------------------------------------------------------------------
// Audit events and the single pure reducer used for both live state and replay.
// ---------------------------------------------------------------------------

const baseEvent = {
  projectId: z.string().min(1).max(256),
  at: z.string().datetime(),
  actor: z.string().min(1).max(256),
  reason: z.string().min(1).max(2_000),
};
const auditEventSchema = z.discriminatedUnion('type', [
  z.object({ ...baseEvent, type: z.literal('episode-resolved'), episodeId: z.string().min(1), findingId: z.string().min(1), evidenceRefs: z.array(z.string()).max(100), prior: z.null() }).strict(),
  z.object({ ...baseEvent, type: z.literal('override-merge'), sourceFindingId: z.string().min(1), targetFindingId: z.string().min(1), prior: z.string().nullable() }).strict(),
  z.object({ ...baseEvent, type: z.literal('override-alias'), sourceFindingId: z.string().min(1), targetFindingId: z.string().min(1), prior: z.string().nullable() }).strict(),
  z.object({ ...baseEvent, type: z.literal('override-split'), sourceFindingId: z.string().min(1), newFindingId: z.string().min(1), occurrenceIds: z.array(z.string().min(1)).min(1), prior: z.record(z.string(), z.string()) }).strict(),
  z.object({ ...baseEvent, type: z.literal('override-resolve'), episodeId: z.string().min(1), findingId: z.string().min(1), prior: z.literal('open') }).strict(),
  z.object({ ...baseEvent, type: z.literal('override-reopen'), findingId: z.string().min(1), episodeId: z.string().min(1), prior: z.literal('resolved') }).strict(),
]);
export type AuditEvent = z.infer<typeof auditEventSchema>;

export interface AuditState {
  projectId: string;
  /** source finding id -> canonical target finding id (merge/alias). */
  mergedInto: Record<string, string>;
  /** occurrence id -> finding id it was split onto. */
  occurrenceOwner: Record<string, string>;
  /** episode id -> how it was resolved. */
  resolutions: Record<string, { at: string; actor: string; reason: string; evidenceRefs: string[]; manual: boolean }>;
  /** episode ids opened by a human reopen, per finding. */
  reopened: Record<string, string[]>;
  eventCount: number;
}

export function emptyAuditState(projectId: string): AuditState {
  return { projectId, mergedInto: {}, occurrenceOwner: {}, resolutions: {}, reopened: {}, eventCount: 0 };
}

/** Pure: returns a new state; the input is never mutated. */
export function reduceAudit(state: AuditState, event: AuditEvent): AuditState {
  if (event.projectId !== state.projectId) throw new Error('audit event project id does not match the audit state');
  const next: AuditState = JSON.parse(JSON.stringify(state)) as AuditState;
  next.eventCount += 1;
  switch (event.type) {
    case 'episode-resolved':
      next.resolutions[event.episodeId] = { at: event.at, actor: event.actor, reason: event.reason, evidenceRefs: event.evidenceRefs, manual: false };
      break;
    case 'override-resolve':
      next.resolutions[event.episodeId] = { at: event.at, actor: event.actor, reason: event.reason, evidenceRefs: [], manual: true };
      break;
    case 'override-merge':
    case 'override-alias':
      if (resolveMerged(next.mergedInto, event.targetFindingId) === event.sourceFindingId) throw new Error('merge would create a cycle');
      next.mergedInto[event.sourceFindingId] = event.targetFindingId;
      break;
    case 'override-split':
      for (const id of event.occurrenceIds) next.occurrenceOwner[id] = event.newFindingId;
      break;
    case 'override-reopen':
      (next.reopened[event.findingId] ??= []).push(event.episodeId);
      break;
  }
  return next;
}

export function replayAudit(projectId: string, events: readonly AuditEvent[]): AuditState {
  return events.reduce(reduceAudit, emptyAuditState(projectId));
}

function resolveMerged(mergedInto: Record<string, string>, id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (mergedInto[current] !== undefined) {
    if (seen.has(current)) throw new Error(`merge cycle at ${current}`);
    seen.add(current);
    current = mergedInto[current]!;
  }
  return current;
}

/** Append-only JSONL audit log, one per project data directory. */
export class FindingAuditLog {
  private readonly path: string;
  private events: AuditEvent[];
  private current: AuditState;

  constructor(readonly dataDir: string, readonly projectId: string) {
    this.path = join(dataDir, AUDIT_LOG_FILE);
    this.events = this.load();
    this.current = replayAudit(projectId, this.events);
  }

  private load(): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean)
      .map((line) => auditEventSchema.parse(JSON.parse(line)))
      .filter((event) => event.projectId === this.projectId);
  }

  /** Re-read the file so other store instances' events are visible. */
  refresh(): AuditState {
    this.events = this.load();
    this.current = replayAudit(this.projectId, this.events);
    return this.current;
  }

  state(): AuditState { return this.refresh(); }
  history(): readonly AuditEvent[] { this.refresh(); return structuredClone(this.events); }

  append(event: AuditEvent): AuditEvent {
    const parsed = auditEventSchema.parse(event);
    this.refresh();
    const next = reduceAudit(this.current, parsed); // validates before persisting
    mkdirSync(this.dataDir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.events.push(parsed);
    this.current = next;
    return parsed;
  }

  /** True when the incrementally maintained state equals a from-empty replay of the file. */
  verifyReplay(): boolean {
    const live = this.refresh();
    return JSON.stringify(live) === JSON.stringify(replayAudit(this.projectId, this.load()));
  }
}

// ---------------------------------------------------------------------------
// Resolution rule
// ---------------------------------------------------------------------------

export type ResolutionDecision = { resolve: true; evidenceRefs: string[] } | { resolve: false; why: string };

const COMPARABLE_ENV_KEYS = ['platform', 'arch', 'os'] as const;

/**
 * Conservative: resolve only on explicit, valid, relevant, comparable, passing coverage
 * that is newer than the episode's last observation. Everything else, including omission,
 * leaves the episode open.
 */
export function evaluateResolution(
  run: VerificationRun,
  check: VerificationCheckRun | undefined,
  lastCheckId: string,
  lastEnvironment: Record<string, string>,
  episodeLastSeenAt: string,
): ResolutionDecision {
  if (!check) return { resolve: false, why: 'check omitted from run' };
  if (check.checkId !== lastCheckId) return { resolve: false, why: 'irrelevant check' };
  if (run.status === 'infrastructure-error' || run.status === 'cancelled' || run.status === 'unknown') return { resolve: false, why: `run ${run.status}` };
  if (check.status !== 'passed') return { resolve: false, why: `check ${check.status}` };
  if (check.outputTruncated) return { resolve: false, why: 'truncated output' };
  if (check.coverage.selected < 1 || check.coverage.passed < 1) return { resolve: false, why: 'no passing coverage' };
  if (check.coverage.passed + check.coverage.skipped < check.coverage.selected) return { resolve: false, why: 'incomplete coverage' };
  if (check.findingFingerprint) return { resolve: false, why: 'check still reports a finding' };
  for (const key of COMPARABLE_ENV_KEYS) {
    if (lastEnvironment[key] !== undefined && run.environment[key] !== lastEnvironment[key]) return { resolve: false, why: `environment ${key} differs` };
  }
  if (Date.parse(run.finishedAt) <= Date.parse(episodeLastSeenAt)) return { resolve: false, why: 'coverage predates the last observation' };
  return { resolve: true, evidenceRefs: [`${run.verificationId}:${check.checkId}:${check.attempt}`] };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface IngestOutcome {
  opened: { findingId: string; episodeId: string; created: boolean; reopened: boolean }[];
  appended: { findingId: string; episodeId: string; occurrenceId: string }[];
  resolved: { findingId: string; episodeId: string }[];
  retained: { findingId: string; episodeId: string; why: string }[];
}

const PASS_ONLY_KINDS = verificationFindingKindSchema.options;

function kindOf(check: VerificationCheckRun): FindingRecord['kind'] {
  const id = check.findingStrategyId;
  const match = PASS_ONLY_KINDS.find((kind) => FINGERPRINT_STRATEGIES[kind].id === id);
  return match ?? 'test-failure';
}

/** Follow merge aliases (store and audit log) to the canonical finding. */
function canonicalFinding(store: FindingLedgerStore, audit: AuditState, finding: FindingRecord): string {
  const snapshot = store.snapshot();
  const merged: Record<string, string> = { ...audit.mergedInto };
  for (const alias of snapshot.aliases) merged[alias.sourceFindingId] ??= alias.targetFindingId;
  return resolveMerged(merged, finding.id);
}

export function ingestVerificationRun(
  store: FindingLedgerStore,
  audit: FindingAuditLog,
  run: VerificationRun,
): IngestOutcome {
  if (run.projectId !== store.projectId) throw new Error('verification result project id does not match the ledger project');
  const outcome: IngestOutcome = { opened: [], appended: [], resolved: [], retained: [] };
  const failingFindingIds = new Set<string>();

  for (const check of run.checks) {
    if (check.status !== 'failed' || !check.findingFingerprint || !check.findingStrategyId || !check.findingStrategyVersion) continue;
    const existing = store.getFindingByFingerprint(check.findingFingerprint);
    const created = !existing;
    const stored = existing ?? store.createFinding({
      fingerprint: check.findingFingerprint, kind: kindOf(check),
      strategyId: check.findingStrategyId, strategyVersion: check.findingStrategyVersion, at: run.finishedAt,
    });
    const findingId = canonicalFinding(store, audit.state(), stored);
    failingFindingIds.add(findingId);
    const occurrence = store.appendOccurrence(occurrenceFromVerification(run, check, findingId));
    const episodes = store.episodesForFinding(findingId);
    const open = episodes.find((episode) => episode.status === 'open');
    if (open) {
      store.appendOccurrenceToEpisode(open.id, occurrence.id);
      outcome.appended.push({ findingId, episodeId: open.id, occurrenceId: occurrence.id });
    } else {
      const episode = store.createEpisode({ findingId, occurrenceIds: [occurrence.id], openedAt: run.finishedAt });
      outcome.opened.push({ findingId, episodeId: episode.id, created, reopened: episodes.length > 0 });
    }
  }

  const snapshot = store.snapshot();
  const checks = new Map(run.checks.map((check) => [check.checkId, check]));
  for (const episode of snapshot.episodes.filter((record: EpisodeRecord) => record.status === 'open')) {
    if (failingFindingIds.has(episode.findingId)) continue;
    const last = snapshot.occurrences.filter((o) => episode.occurrenceIds.includes(o.id)).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).at(-1);
    if (!last) continue;
    const decision = evaluateResolution(run, checks.get(last.checkId), last.checkId, last.environment, episode.lastSeenAt);
    if (!decision.resolve) {
      outcome.retained.push({ findingId: episode.findingId, episodeId: episode.id, why: decision.why });
      continue;
    }
    store.resolveEpisode(episode.id, run.finishedAt);
    audit.append({
      type: 'episode-resolved', projectId: run.projectId, at: run.finishedAt, actor: 'verification-ingest',
      reason: 'valid relevant passing coverage', episodeId: episode.id, findingId: episode.findingId,
      evidenceRefs: decision.evidenceRefs, prior: null,
    });
    outcome.resolved.push({ findingId: episode.findingId, episodeId: episode.id });
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Human overrides: applied to the store where it supports them, always audited.
// ---------------------------------------------------------------------------

export function mergeFindings(
  store: FindingLedgerStore, audit: FindingAuditLog,
  input: { sourceFindingId: string; targetFindingId: string; actor: string; reason: string; at: string; action?: 'merge' | 'alias' },
): AuditEvent {
  const action = input.action ?? 'merge';
  const prior = audit.state().mergedInto[input.sourceFindingId] ?? null;
  store.appendAlias({ sourceFindingId: input.sourceFindingId, targetFindingId: input.targetFindingId, action, reason: input.reason, actor: input.actor, createdAt: input.at });
  return audit.append({
    type: action === 'merge' ? 'override-merge' : 'override-alias', projectId: store.projectId, at: input.at, actor: input.actor,
    reason: input.reason, sourceFindingId: input.sourceFindingId, targetFindingId: input.targetFindingId, prior,
  });
}

/** Move the given occurrences onto a new finding (identified by a new fingerprint). Originals are not mutated. */
export function splitFinding(
  store: FindingLedgerStore, audit: FindingAuditLog,
  input: { sourceFindingId: string; fingerprint: string; occurrenceIds: string[]; actor: string; reason: string; at: string },
): AuditEvent {
  const source = store.snapshot().findings.find((finding) => finding.id === input.sourceFindingId);
  if (!source) throw new Error(`unknown finding ${input.sourceFindingId}`);
  const owned = new Set(store.occurrencesForFinding(source.id).map((occurrence) => occurrence.id));
  if (input.occurrenceIds.some((id) => !owned.has(id))) throw new Error('split occurrences must belong to the source finding');
  const target = store.createFinding({ fingerprint: input.fingerprint, kind: source.kind, strategyId: source.strategyId, strategyVersion: source.strategyVersion, at: input.at });
  const state = audit.state();
  const prior = Object.fromEntries(input.occurrenceIds.map((id) => [id, state.occurrenceOwner[id] ?? source.id]));
  return audit.append({
    type: 'override-split', projectId: store.projectId, at: input.at, actor: input.actor, reason: input.reason,
    sourceFindingId: source.id, newFindingId: target.id, occurrenceIds: input.occurrenceIds, prior,
  });
}

export function manuallyResolve(
  store: FindingLedgerStore, audit: FindingAuditLog,
  input: { episodeId: string; actor: string; reason: string; at: string },
): AuditEvent {
  const episode = store.snapshot().episodes.find((record) => record.id === input.episodeId);
  if (!episode) throw new Error(`unknown episode ${input.episodeId}`);
  store.resolveEpisode(episode.id, input.at);
  return audit.append({ type: 'override-resolve', projectId: store.projectId, at: input.at, actor: input.actor, reason: input.reason, episodeId: episode.id, findingId: episode.findingId, prior: 'open' });
}

/** Reopen a resolved finding as a new episode seeded with its latest occurrence. */
export function manuallyReopen(
  store: FindingLedgerStore, audit: FindingAuditLog,
  input: { findingId: string; actor: string; reason: string; at: string },
): AuditEvent {
  const episodes = store.episodesForFinding(input.findingId);
  if (episodes.length === 0 || episodes.some((episode) => episode.status === 'open')) throw new Error('only a resolved finding can be reopened');
  const last = store.occurrencesForFinding(input.findingId).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).at(-1);
  if (!last) throw new Error('finding has no occurrences to seed a new episode');
  const episode = store.createEpisode({ findingId: input.findingId, occurrenceIds: [last.id], openedAt: input.at });
  return audit.append({ type: 'override-reopen', projectId: store.projectId, at: input.at, actor: input.actor, reason: input.reason, findingId: input.findingId, episodeId: episode.id, prior: 'resolved' });
}
