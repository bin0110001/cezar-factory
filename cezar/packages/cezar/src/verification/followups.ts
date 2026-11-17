import { createHash } from 'node:crypto';
import type { FindingAuditLog } from './finding-ingest.ts';

/**
 * Idempotent follow-up issues and bounded remediation for dispositions (#666). A follow-up is created exactly once per canonical
 * finding, through an injected publisher (the existing canonical GitHub publisher), keyed by the finding fingerprint. The key is
 * also written into the issue body, so if a crash happens after the issue is created but before the ledger records it, the next
 * run finds the issue by key and records it instead of creating a second one. Remediation climbs a bounded ladder; every step is
 * recorded once, so a replay yields the same next step and never repeats work.
 */

export interface FollowUpFacts {
  fingerprint: string;
  checkId: string;
  severity: string;
  title: string;
  path?: string;
  advisoryId?: string;
  fixAvailable?: boolean;
}

export interface Publisher {
  /** The issue already carrying this idempotency key, if any (searches by the marker in the body). */
  find(key: string): Promise<{ number: number } | undefined>;
  create(input: { key: string; title: string; body: string; labels: string[] }): Promise<{ number: number }>;
}

export const followUpKey = (projectId: string, fingerprint: string): string => `quality-followup:${projectId}:${fingerprint}`;
export const keyMarker = (key: string): string => `<!-- ${key} -->`;

export function followUpBody(f: FollowUpFacts, key: string): string {
  const lines = [
    `A verification run recorded a ${f.severity} finding in \`${f.checkId}\` that needs tracking.`,
    '',
    `- Finding: \`${f.fingerprint.slice(0, 16)}\`${f.advisoryId ? ` (${f.advisoryId})` : ''}`,
    f.path ? `- Where: \`${f.path}\`` : null,
    `- ${f.fixAvailable ? 'A fix is available: upgrade or patch.' : 'No fix is available: mitigate, or request a reviewed waiver.'}`,
    '',
    'This issue is the single tracked item for this finding; repeated detections do not create another.',
    keyMarker(key),
  ];
  return lines.filter((l) => l !== null).join('\n');
}

export interface FollowUpOutcome { key: string; issueNumber: number | null; created: boolean; source: 'ledger' | 'publisher-existing' | 'created' }

/**
 * Ensure one follow-up for a finding. Order: the ledger (already recorded), then the publisher's own search by key (crash recovery),
 * then create. Whatever path is taken, the ledger ends up with exactly one `followup-recorded` event for the fingerprint.
 */
const inflight = new Map<string, Promise<FollowUpOutcome>>();

export function ensureFollowUp(audit: FindingAuditLog, publisher: Publisher, projectId: string, facts: FollowUpFacts, opts: { actor: string; now: string; labels?: string[] }): Promise<FollowUpOutcome> {
  // Two concurrent callers for the same finding in one process share one operation; across processes the publisher's search by key does it.
  const key = followUpKey(projectId, facts.fingerprint);
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = ensureFollowUpOnce(audit, publisher, projectId, facts, opts).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function ensureFollowUpOnce(audit: FindingAuditLog, publisher: Publisher, projectId: string, facts: FollowUpFacts, opts: { actor: string; now: string; labels?: string[] }): Promise<FollowUpOutcome> {
  const key = followUpKey(projectId, facts.fingerprint);
  const recorded = audit.history().find((e) => e.type === 'followup-recorded' && e.fingerprint === facts.fingerprint);
  if (recorded && recorded.type === 'followup-recorded') return { key, issueNumber: recorded.issueNumber, created: false, source: 'ledger' };

  const existing = await publisher.find(key);
  let issueNumber: number;
  let source: FollowUpOutcome['source'];
  if (existing) { issueNumber = existing.number; source = 'publisher-existing'; }
  else {
    const made = await publisher.create({ key, title: facts.title, body: followUpBody(facts, key), labels: opts.labels ?? ['quality-followup'] });
    issueNumber = made.number;
    source = 'created';
  }
  audit.append({ type: 'followup-recorded', projectId, at: opts.now, actor: opts.actor, reason: `follow-up for ${facts.fingerprint.slice(0, 12)}`, fingerprint: facts.fingerprint, key, issueNumber, prior: null });
  return { key, issueNumber, created: source === 'created', source };
}

// ---- bounded remediation -------------------------------------------------------------------------------------------
export const LADDER = ['auto-fix', 'return-to-agent', 'scoped-rerun', 'planning-escalation', 'human-decision'] as const;
export type RemediationStep = (typeof LADDER)[number];

export interface RemediationBudget {
  /** Attempts allowed at each non-final step. */
  attemptsPerStep: number;
  /** Total remediation attempts across the ladder before only a human decision remains. */
  maxTotalAttempts: number;
}

export const DEFAULT_BUDGET: RemediationBudget = { attemptsPerStep: 1, maxTotalAttempts: 4 };

export interface RemediationFacts {
  fingerprint: string;
  /** A safe, deterministic automatic fix exists (formatter, lockfile bump within policy). */
  autoFixable: boolean;
  /** The originating agent run can still receive the finding. */
  agentReachable: boolean;
  /** The block cannot be worked around: only a person can decide. */
  trulyBlocked: boolean;
}

export interface RemediationPlan { step: RemediationStep | 'done'; attempt: number; reason: string; exhausted: boolean }

const recordedSteps = (audit: FindingAuditLog, fingerprint: string) =>
  audit.history().flatMap((e) => (e.type === 'remediation-recorded' && e.fingerprint === fingerprint ? [{ step: e.step as RemediationStep, attempt: e.attempt, outcome: e.outcome }] : []));

/** The next remediation step from what the ledger already recorded: same history, same answer, so a replay repeats nothing. */
export function nextRemediation(audit: FindingAuditLog, facts: RemediationFacts, budget: RemediationBudget = DEFAULT_BUDGET): RemediationPlan {
  const steps = recordedSteps(audit, facts.fingerprint);
  if (steps.some((s) => s.outcome === 'fixed')) return { step: 'done', attempt: steps.length, reason: 'already remediated', exhausted: false };
  const used = (s: RemediationStep) => steps.filter((x) => x.step === s).length;
  const total = steps.filter((x) => x.step !== 'human-decision').length;
  const applicable = (s: RemediationStep): boolean => {
    if (s === 'auto-fix') return facts.autoFixable;
    if (s === 'return-to-agent') return facts.agentReachable;
    return true;
  };
  for (const s of LADDER) {
    if (s === 'human-decision') continue;
    if (!applicable(s) || used(s) >= budget.attemptsPerStep) continue;
    if (total >= budget.maxTotalAttempts) break;
    return { step: s, attempt: used(s) + 1, reason: `attempt ${used(s) + 1} of ${budget.attemptsPerStep} at ${s}`, exhausted: false };
  }
  // The ladder is spent. A persistent human decision is created only when the finding is truly blocked; otherwise it stays recorded.
  if (facts.trulyBlocked && used('human-decision') === 0) return { step: 'human-decision', attempt: 1, reason: 'bounded remediation exhausted and the block cannot be worked around', exhausted: true };
  return { step: 'done', attempt: total, reason: facts.trulyBlocked ? 'a human decision is already open' : 'bounded remediation exhausted; the finding stays recorded as a follow-up', exhausted: true };
}

/** Record that a step was taken. Idempotent per (fingerprint, step, attempt): replaying it writes nothing. */
export function recordRemediation(audit: FindingAuditLog, projectId: string, input: { fingerprint: string; step: RemediationStep; attempt: number; outcome: string; actor: string; now: string }): { recorded: boolean } {
  if (recordedSteps(audit, input.fingerprint).some((s) => s.step === input.step && s.attempt === input.attempt)) return { recorded: false };
  audit.append({ type: 'remediation-recorded', projectId, at: input.now, actor: input.actor, reason: `${input.step} attempt ${input.attempt}: ${input.outcome}`, fingerprint: input.fingerprint, step: input.step, attempt: input.attempt, outcome: input.outcome, prior: null });
  return { recorded: true };
}

/** A stable digest of a finding's remediation history, to compare dispositions after a replay. */
export function remediationDigest(audit: FindingAuditLog, fingerprint: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(recordedSteps(audit, fingerprint))).digest('hex')}`;
}
