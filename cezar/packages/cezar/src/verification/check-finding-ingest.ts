import { createHash } from 'node:crypto';
import { FINGERPRINT_STRATEGIES } from './fingerprint.ts';
import { FindingAuditLog } from './finding-ingest.ts';
import type { FindingLedgerStore } from './finding-ledger.ts';
import { computeDispositions, type DispositionResult, type RunFacts, type TrustedBaseline } from './disposition.ts';

/**
 * Persist check-provider findings in the existing #52 ledger (#664). Findings arrive already normalized (a provider-independent
 * fingerprint, severity, a few diagnostics); this module only stores them as `check-finding` kinds, opens and extends episodes,
 * resolves an episode when the disposition rules say a complete, comparable run no longer shows it, and appends one
 * `disposition-recorded` audit event per run. No parallel finding store: it is the same ledger and audit log.
 *
 * Replay-safe: occurrence ids are derived from the run, so ingesting the same run twice adds nothing and returns the same
 * dispositions.
 */

export interface CheckFindingInput {
  fingerprint: string;
  severity: string;
  diagnostics?: Array<{ code: string; message: string; severity?: 'info' | 'warning' | 'error'; file?: string; line?: number }>;
}

export interface CheckIngestInput {
  projectId: string;
  verificationId: string;
  runId: string;
  attempt?: number;
  checkId: string;
  commitSha: string;
  environment: Record<string, string>;
  observedAt: string;
  findings: readonly CheckFindingInput[];
  baseline: TrustedBaseline | undefined;
  waived?: readonly string[];
  run: RunFacts;
  evidenceRefs?: string[];
}

export interface CheckIngestOutcome {
  dispositions: DispositionResult;
  opened: string[];
  appended: string[];
  resolved: string[];
  /** True when this exact run had already been ingested (nothing was written). */
  replayed: boolean;
}

const occurrenceId = (i: CheckIngestInput, fingerprint: string): string =>
  `occ-${createHash('sha256').update(JSON.stringify([i.projectId, i.verificationId, i.checkId, fingerprint])).digest('hex').slice(0, 32)}`;

export function ingestCheckFindings(store: FindingLedgerStore, audit: FindingAuditLog, input: CheckIngestInput): CheckIngestOutcome {
  if (input.projectId !== store.projectId) throw new Error('check result project id does not match the ledger project');
  const strategy = FINGERPRINT_STRATEGIES['check-finding'];
  const snapshot = store.snapshot();

  // What this check already has in the ledger: open episodes, and findings whose episodes are all resolved.
  const checkFindingIds = new Set(snapshot.occurrences.filter((o) => o.checkId === input.checkId).map((o) => o.findingId));
  const checkFindings = snapshot.findings.filter((f) => f.kind === 'check-finding' && checkFindingIds.has(f.id));
  const openByFinding = new Map(snapshot.episodes.filter((e) => e.status === 'open').map((e) => [e.findingId, e]));
  const previouslyOpen = checkFindings.filter((f) => openByFinding.has(f.id)).map((f) => f.fingerprint);
  const previouslyResolved = checkFindings.filter((f) => !openByFinding.has(f.id)).map((f) => f.fingerprint);

  const dispositions = computeDispositions({
    findings: input.findings, baseline: input.baseline, previouslyOpen, previouslyResolved, waived: input.waived, run: input.run,
  });

  const outcome: CheckIngestOutcome = { dispositions, opened: [], appended: [], resolved: [], replayed: false };
  const unique = [...new Map(input.findings.map((f) => [f.fingerprint, f])).values()];

  // Replay guard: a disposition event for this exact run and check means it was ingested before; nothing more is written.
  const alreadyIngested = audit.history().some((e) => e.type === 'disposition-recorded' && e.verificationId === input.verificationId && e.checkId === input.checkId);

  if (!alreadyIngested) {
    for (const f of unique) {
      const existing = store.getFindingByFingerprint(f.fingerprint);
      const stored = existing ?? store.createFinding({ fingerprint: f.fingerprint, kind: 'check-finding', strategyId: strategy.id, strategyVersion: strategy.version, at: input.observedAt });
      const occ = store.appendOccurrence({
        id: occurrenceId(input, f.fingerprint), projectId: input.projectId, findingId: stored.id, verificationId: input.verificationId, runId: input.runId,
        attempt: input.attempt ?? 1, checkId: input.checkId, commitSha: input.commitSha, environment: input.environment,
        diagnostics: (f.diagnostics ?? []).slice(0, 200).map((d) => ({ code: d.code.slice(0, 128), severity: d.severity ?? 'error', message: d.message.slice(0, 2000), ...(d.file ? { file: d.file } : {}), ...(d.line ? { line: d.line } : {}) })),
        evidenceRefs: input.evidenceRefs ?? [], observedAt: input.observedAt,
      });
      const open = store.episodesForFinding(stored.id).find((e) => e.status === 'open');
      if (open) { store.appendOccurrenceToEpisode(open.id, occ.id); outcome.appended.push(f.fingerprint); }
      else { store.createEpisode({ findingId: stored.id, occurrenceIds: [occ.id], openedAt: input.observedAt }); outcome.opened.push(f.fingerprint); }
    }
    for (const fp of dispositions.resolvable) {
      const finding = store.getFindingByFingerprint(fp);
      const open = finding ? store.episodesForFinding(finding.id).find((e) => e.status === 'open') : undefined;
      if (!finding || !open) continue;
      store.resolveEpisode(open.id, input.observedAt);
      audit.append({
        type: 'episode-resolved', projectId: input.projectId, at: input.observedAt, actor: 'check-finding-ingest', reason: 'complete, comparable run no longer shows the finding',
        episodeId: open.id, findingId: finding.id, evidenceRefs: input.evidenceRefs ?? [], prior: null,
      });
      outcome.resolved.push(fp);
    }
    audit.append({
      type: 'disposition-recorded', projectId: input.projectId, at: input.observedAt, actor: input.run.actor, reason: `disposition ${dispositions.run} for ${input.checkId}`,
      verificationId: input.verificationId, checkId: input.checkId, commitSha: input.commitSha, digest: dispositions.digest, runDisposition: dispositions.run, policyVersion: input.run.policyVersion,
      summary: dispositions.summary, prior: null,
    });
  } else {
    outcome.replayed = true;
  }
  return outcome;
}
