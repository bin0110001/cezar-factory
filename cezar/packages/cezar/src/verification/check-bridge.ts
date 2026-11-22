import type { RunCheckOutcome } from '../server/verification/checks/check-runner.ts';
import type { CheckIngestInput } from './check-finding-ingest.ts';
import type { CheckRun, FindingFacts } from './disposition-rules.ts';
import type { RunFacts, TrustedBaseline } from './disposition.ts';
import type { DispositionResult } from './disposition.ts';

/**
 * Bridge from a check-provider outcome to the ledger and the disposition rules (#669). It maps; it decides nothing: the status
 * and feed from the runner become the run facts (a crash, an unexecuted suite or an unavailable feed can only ever become an
 * unusable run), and the normalized findings become ledger inputs. Waived findings are excluded here by their waiver status and
 * stay visible through the `waived` list on the dispositions.
 */

export interface BridgeContext {
  projectId: string;
  verificationId: string;
  runId: string;
  commitSha: string;
  environment: Record<string, string>;
  observedAt: string;
  baseline: TrustedBaseline | undefined;
  baseSha: string;
  envFingerprint: string;
  policyVersion: string;
  actor: string;
  /** Whether a path is in the impacted scope of the change. */
  impacted?: (path: string | undefined) => boolean;
  attempts?: number;
}

export function runFactsOf(o: RunCheckOutcome, ctx: BridgeContext): RunFacts {
  const r = o.result;
  const completed = r.execution === 'completed';
  return {
    status: r.status,
    execution: r.execution,
    // An unknown result or an unavailable/stale feed means the selected checks did not all produce a usable answer.
    selectionComplete: completed && r.status !== 'unknown',
    coverageComplete: completed && r.feed !== 'stale' && r.feed !== 'unavailable',
    evidenceFresh: r.feed === 'fresh' || r.feed === 'not-applicable',
    envFingerprint: ctx.envFingerprint, baseSha: ctx.baseSha, policyVersion: ctx.policyVersion, actor: ctx.actor,
  };
}

export function toIngestInput(o: RunCheckOutcome, ctx: BridgeContext): CheckIngestInput {
  const active = o.findings.filter((f) => f.waiver.status === 'none');
  return {
    projectId: ctx.projectId, verificationId: ctx.verificationId, runId: ctx.runId, checkId: o.result.checkId, commitSha: ctx.commitSha,
    environment: ctx.environment, observedAt: ctx.observedAt, baseline: ctx.baseline,
    waived: o.findings.filter((f) => f.waiver.status !== 'none').map((f) => f.fingerprint),
    findings: active.map((f) => ({
      fingerprint: f.fingerprint, severity: f.severity,
      diagnostics: [{ code: f.ruleId, message: f.evidence || f.ruleId, severity: f.severity === 'info' || f.severity === 'low' ? 'warning' : 'error', ...(f.path ? { file: f.path } : {}), ...(f.line ? { line: f.line } : {}) }],
    })),
    run: runFactsOf(o, ctx),
    evidenceRefs: [o.provenance.inputsDigest, o.provenance.configDigest, ...active.map((f) => f.reviewerSessionId)].filter((v): v is string => Boolean(v)),
  };
}

export function toCheckRun(o: RunCheckOutcome, dispositions: DispositionResult, ctx: BridgeContext): CheckRun {
  const facts: Record<string, FindingFacts> = {};
  for (const f of o.findings) {
    facts[f.fingerprint] = { class: f.class, severity: f.severity, impacted: ctx.impacted?.(f.path) ?? false, category: f.category };
  }
  return { checkId: o.result.checkId, result: dispositions, facts, attempts: ctx.attempts ?? 0 };
}
