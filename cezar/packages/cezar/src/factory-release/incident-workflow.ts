import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const FAILURE_CLASSES = new Set(['release', 'automation', 'shadow_drift', 'failed_refetch', 'compatibility', 'infrastructure']);
const EVIDENCE_REF = /^(?:receipt|evidence|commit):[A-Za-z0-9_.:-]{1,200}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/i;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
export const MAX_INCIDENT_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (path: string, options: { readonly: boolean; fileMustExist: boolean; timeout: number }) => {
  pragma(statement: string): unknown;
  prepare(statement: string): { get(...params: unknown[]): unknown };
  close(): void;
};

export type ReleaseIncidentWorkflowOutcome = 'passed' | 'blocked' | 'needs_input' | 'needs_research' | 'exhausted' | 'unknown';

export interface ReleaseIncidentWorkflowResult {
  outcome: ReleaseIncidentWorkflowOutcome;
  outputs: Record<string, unknown>;
}

const unknownResult = (reasonCode: string): ReleaseIncidentWorkflowResult => ({
  outcome: 'unknown',
  outputs: { status: 'unknown', reasonCode, nextAction: 'inspect-authoritative-controller-evidence', evidenceReferences: [] },
});

/**
 * Converts one deterministic incident-ledger admission and its matching repair
 * receipt into a typed child-workflow result. Free-form summaries, including
 * optional Hindsight output, are deliberately ignored.
 */
function mapReleaseIncidentWorkflowOutcome(inputs: Record<string, unknown>): ReleaseIncidentWorkflowResult {
  const eventId = inputs.eventId;
  const failureClass = inputs.failureClass;
  const fingerprint = inputs.fingerprint;
  const evidenceReferences = inputs.evidenceReferences;
  const admission = inputs.ledgerAdmission;
  const repair = inputs.repairResult;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)
      || typeof failureClass !== 'string' || !FAILURE_CLASSES.has(failureClass)
      || typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)
      || !Array.isArray(evidenceReferences) || evidenceReferences.length > 16
      || !evidenceReferences.every((ref) => typeof ref === 'string' && EVIDENCE_REF.test(ref))
      || !admission || typeof admission !== 'object' || Array.isArray(admission)
      || !repair || typeof repair !== 'object' || Array.isArray(repair)) {
    return unknownResult('incident-input-missing-or-invalid');
  }

  const ledger = admission as Record<string, unknown>;
  const repairResult = repair as Record<string, unknown>;
  if (ledger.failureClass !== failureClass || ledger.fingerprint !== fingerprint || typeof ledger.allowed !== 'boolean') {
    return unknownResult('ledger-admission-identity-mismatch');
  }
  const attempt = ledger.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) {
    return unknownResult('ledger-attempt-invalid');
  }

  const outputs: Record<string, unknown> = {
    eventId,
    failureClass,
    fingerprint,
    attempt,
    status: 'unknown',
    reasonCode: 'repair-result-unverified',
    nextAction: 'inspect-authoritative-controller-evidence',
    evidenceReferences,
  };
  if (typeof ledger.budget === 'number' && Number.isInteger(ledger.budget) && ledger.budget > 0) outputs.budget = ledger.budget;
  if (typeof ledger.nextAttemptAt === 'number' && Number.isFinite(ledger.nextAttemptAt)) {
    outputs.nextAttemptAt = new Date(ledger.nextAttemptAt * 1000).toISOString();
  }

  if (!ledger.allowed) {
    if (ledger.reason === 'backoff' && typeof outputs.nextAttemptAt === 'string') {
      return { outcome: 'needs_input', outputs: { ...outputs, status: 'retryable', reasonCode: 'ledger-backoff', nextAction: 'retry-after-backoff' } };
    }
    if (ledger.reason === 'budget-exhausted') {
      return { outcome: 'exhausted', outputs: { ...outputs, status: 'exhausted', reasonCode: 'ledger-budget-exhausted', nextAction: 'escalate-to-operator' } };
    }
    return unknownResult('ledger-denial-unrecognized');
  }

  if (typeof ledger.budget !== 'number' || !Number.isInteger(ledger.budget) || ledger.budget < 1
      || typeof ledger.escalated !== 'boolean') return unknownResult('ledger-admission-incomplete');

  const receipt = repairResult.receiptRecord;
  const repairStatus = repairResult.status;
  if (!['applied', 'unchanged', 'failed', 'skipped', 'dry-run', 'not_run'].includes(String(repairStatus))) {
    return unknownResult('repair-status-missing-or-invalid');
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    if (!['skipped', 'dry-run', 'not_run'].includes(String(repairStatus))) return unknownResult('repair-effect-has-no-durable-receipt');
    if (ledger.escalated) {
      return { outcome: 'needs_research', outputs: { ...outputs, status: 'escalated', reasonCode: 'final-attempt-needs-review', nextAction: 'open-incident-escalation' } };
    }
    return { outcome: 'needs_input', outputs: { ...outputs, status: 'retryable', reasonCode: 'repair-result-not-recorded', nextAction: 'resume-bounded-controller-recovery' } };
  }

  const receiptValue = receipt as Record<string, unknown>;
  if (receiptValue.failureClass !== failureClass || receiptValue.fingerprint !== fingerprint
      || !['fixed', 'open'].includes(String(receiptValue.state)) || typeof receiptValue.probePassed !== 'boolean') {
    return unknownResult('repair-receipt-identity-or-probe-invalid');
  }
  if (receiptValue.state === 'fixed' && receiptValue.probePassed && ['applied', 'unchanged'].includes(String(repairStatus))) {
    return { outcome: 'passed', outputs: { ...outputs, status: 'recovered', reasonCode: 'original-probe-passed', nextAction: 'return-to-invoking-workflow' } };
  }
  if (receiptValue.state === 'fixed' || receiptValue.probePassed) return unknownResult('repair-receipt-state-conflicts-with-probe');
  if (ledger.escalated) {
    return { outcome: 'needs_research', outputs: { ...outputs, status: 'escalated', reasonCode: 'final-attempt-probe-still-failing', nextAction: 'open-incident-escalation' } };
  }
  return { outcome: 'blocked', outputs: { ...outputs, status: 'validation_failed', reasonCode: 'original-probe-still-failing', nextAction: 'keep-incident-open' } };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameLedgerDecision(supplied: unknown, authoritative: unknown): boolean {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
      || !authoritative || typeof authoritative !== 'object' || Array.isArray(authoritative)) return false;
  const keys = ['allowed', 'reason', 'failureClass', 'fingerprint', 'attempt', 'budget', 'nextAttemptAt', 'escalated', 'knownDebt', 'releaseFailure'];
  const left = supplied as Record<string, unknown>;
  const right = authoritative as Record<string, unknown>;
  return keys.every((key) => (left[key] === undefined && right[key] === undefined) || canonical(left[key]) === canonical(right[key]));
}

/** Verify the adapter payload against the configured read-only ledger and receipt store before mapping it. */
export function evaluateReleaseIncidentWorkflow(
  inputs: Record<string, unknown>,
  storePath = process.env.CEZ_FACTORY_RELEASE_STORE,
): ReleaseIncidentWorkflowResult {
  if (!storePath?.trim()) return unknownResult('release-store-not-configured');
  const eventId = inputs.eventId;
  const failureClass = inputs.failureClass;
  const fingerprint = inputs.fingerprint;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)
      || typeof failureClass !== 'string' || !FAILURE_CLASSES.has(failureClass)
      || typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return unknownResult('incident-identity-invalid');

  const store = resolve(storePath);
  let database: InstanceType<typeof Database> | undefined;
  try {
    database = new Database(join(store, 'incidents.sqlite3'), { readonly: true, fileMustExist: true, timeout: 250 });
    database.pragma('query_only = ON');
    const row = database.prepare('SELECT failure_class,fingerprint,result_json,created_at FROM incident_events WHERE event_id=?').get(eventId) as
      { failure_class?: unknown; fingerprint?: unknown; result_json?: unknown; created_at?: unknown } | undefined;
    if (!row || row.failure_class !== failureClass || row.fingerprint !== fingerprint || typeof row.result_json !== 'string'
        || typeof row.created_at !== 'number' || !Number.isFinite(row.created_at)) {
      return unknownResult('authoritative-ledger-event-not-found');
    }
    const ledgerAge = Date.now() - row.created_at * 1000;
    if (!Number.isFinite(ledgerAge) || ledgerAge < 0 || ledgerAge > MAX_INCIDENT_EVIDENCE_AGE_MS) return unknownResult('ledger-event-stale');
    const decision = JSON.parse(row.result_json) as unknown;
    const admission = inputs.ledgerAdmission;
    if (!sameLedgerDecision(admission, decision)) return unknownResult('ledger-admission-does-not-match-event-record');

    const repairResult = inputs.repairResult;
    if (!repairResult || typeof repairResult !== 'object' || Array.isArray(repairResult)) return unknownResult('repair-result-missing');
    const repair = repairResult as Record<string, unknown>;
    const receiptRecord = repair.receiptRecord;
    const evidenceReferences = inputs.evidenceReferences;
    if (receiptRecord === undefined && ['skipped', 'dry-run', 'not_run'].includes(String(repair.status))) {
      return mapReleaseIncidentWorkflowOutcome(inputs);
    }
    if (!receiptRecord || typeof receiptRecord !== 'object' || Array.isArray(receiptRecord) || !Array.isArray(evidenceReferences)) {
      return unknownResult('durable-repair-receipt-missing');
    }
    const receiptRefs = evidenceReferences.filter((ref): ref is string => typeof ref === 'string' && ref.startsWith('receipt:'));
    if (receiptRefs.length !== 1) return unknownResult('durable-receipt-reference-missing-or-ambiguous');
    const receiptRef = receiptRefs[0];
    if (!receiptRef) return unknownResult('durable-receipt-reference-missing-or-ambiguous');
    const stem = receiptRef.slice('receipt:'.length);
    if (!/^[a-f0-9]{16}-[a-f0-9]{16}$/i.test(stem) || !stem.toLowerCase().endsWith(`-${fingerprint.slice(0, 16).toLowerCase()}`)) {
      return unknownResult('durable-receipt-reference-invalid');
    }
    const actualReceipt = JSON.parse(readFileSync(join(store, 'repair-receipts', `${stem}.json`), 'utf8')) as unknown;
    if (canonical(receiptRecord) !== canonical(actualReceipt)) return unknownResult('repair-receipt-does-not-match-store');
    if (!actualReceipt || typeof actualReceipt !== 'object' || Array.isArray(actualReceipt)) return unknownResult('repair-receipt-invalid');
    const stored = actualReceipt as Record<string, unknown>;
    const updatedAt = typeof stored.updatedAt === 'string' ? Date.parse(stored.updatedAt) : Number.NaN;
    const receiptAge = Date.now() - updatedAt;
    if (stored.schemaVersion !== 'factory-drift-repair-receipt/v1' || stored.failureClass !== failureClass
        || stored.fingerprint !== fingerprint || typeof stored.key !== 'string'
        || createHash('sha256').update(stored.key).digest('hex').slice(0, 16) !== stem.slice(0, 16)
        || !stem.toLowerCase().endsWith(`-${String(stored.fingerprint).slice(0, 16).toLowerCase()}`)
        || !Number.isFinite(receiptAge) || receiptAge < 0 || receiptAge > MAX_INCIDENT_EVIDENCE_AGE_MS) {
      return unknownResult('repair-receipt-stale-or-invalid');
    }
    return mapReleaseIncidentWorkflowOutcome({
      ...inputs,
      repairResult: { ...repair, receiptRecord: actualReceipt },
    });
  } catch {
    return unknownResult('authoritative-release-evidence-unavailable');
  } finally {
    database?.close();
  }
}

export const releaseIncidentRecoveryGate = {
  policy: 'release.incident.recovery-result',
  evaluate: ({ inputs }: { inputs: Record<string, unknown> }) => evaluateReleaseIncidentWorkflow(inputs),
};
