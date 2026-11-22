import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';
import { evaluateReleaseIncidentWorkflow } from './incident-workflow.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (path: string) => {
  exec(statement: string): void;
  prepare(statement: string): { run(...params: unknown[]): void };
  close(): void;
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const receiptKey = 'controller-finding';
const receiptStem = `${createHash('sha256').update(receiptKey).digest('hex').slice(0, 16)}-${'a'.repeat(16)}`;
const receiptRecord = (state: 'fixed' | 'open', probePassed: boolean, fingerprint = 'a'.repeat(64)) => ({
  schemaVersion: 'factory-drift-repair-receipt/v1', channel: 'stable', key: receiptKey,
  failureClass: 'infrastructure', fingerprint, state, probePassed, updatedAt: new Date().toISOString(),
});

const base = (): Record<string, unknown> & { ledgerAdmission: Record<string, unknown>; repairResult: Record<string, unknown> } => ({
  eventId: 'event:release:42',
  failureClass: 'infrastructure',
  fingerprint: 'a'.repeat(64),
  evidenceReferences: [`receipt:${receiptStem}`, `commit:${'b'.repeat(40)}`],
  ledgerAdmission: { allowed: true, failureClass: 'infrastructure', fingerprint: 'a'.repeat(64), attempt: 1, budget: 3, escalated: false, knownDebt: true },
  repairResult: {
    status: 'applied',
    receiptRecord: receiptRecord('fixed', true),
  },
});

function evaluate(inputs: Record<string, unknown>, storedReceipt?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'factory-incident-gate-'));
  roots.push(root);
  const db = new Database(join(root, 'incidents.sqlite3'));
  try {
    db.exec('CREATE TABLE incident_events(event_id TEXT PRIMARY KEY,failure_class TEXT,fingerprint TEXT,result_json TEXT,created_at REAL)');
    const admission = inputs.ledgerAdmission as Record<string, unknown>;
    const persisted = Object.fromEntries(Object.entries(admission).filter(([key]) => key !== 'duplicate'));
    db.prepare('INSERT INTO incident_events(event_id,failure_class,fingerprint,result_json,created_at) VALUES(?,?,?,?,?)')
      .run(inputs.eventId, inputs.failureClass, inputs.fingerprint, JSON.stringify(persisted), Date.now() / 1000);
  } finally { db.close(); }
  const repair = inputs.repairResult as Record<string, unknown>;
  const receipt = storedReceipt ?? repair.receiptRecord;
  if (receipt && typeof receipt === 'object') {
    const reference = (inputs.evidenceReferences as string[]).find((ref) => /^receipt:[a-f0-9]{16}-[a-f0-9]{16}$/i.test(ref));
    if (reference) {
      const directory = join(root, 'repair-receipts');
      mkdirSync(directory);
      writeFileSync(join(directory, `${reference.slice('receipt:'.length)}.json`), JSON.stringify(receipt));
    }
  }
  return evaluateReleaseIncidentWorkflow(inputs, root);
}

describe('release incident workflow result adapter', () => {
  it('returns recovered only when the matching durable receipt says the original probe passed', () => {
    expect(evaluate(base())).toMatchObject({ outcome: 'passed', outputs: { status: 'recovered', nextAction: 'return-to-invoking-workflow' } });
  });

  it('keeps known debt from becoming a successful result without a passing probe', () => {
    const input = base();
    input.repairResult.receiptRecord = receiptRecord('open', false);
    expect(evaluate(input)).toMatchObject({ outcome: 'blocked', outputs: { status: 'validation_failed', nextAction: 'keep-incident-open' } });
  });

  it('returns retryable for an authoritative backoff decision and preserves its retry time', () => {
    const input = base();
    input.ledgerAdmission = { allowed: false, reason: 'backoff', failureClass: 'infrastructure', fingerprint: 'a'.repeat(64), attempt: 1, nextAttemptAt: 1_800_000_000 };
    expect(evaluate(input)).toMatchObject({ outcome: 'needs_input', outputs: { status: 'retryable', nextAttemptAt: '2027-01-15T08:00:00.000Z' } });
  });

  it('returns escalated after the final allowed attempt remains unresolved', () => {
    const input = base();
    input.ledgerAdmission.escalated = true;
    input.repairResult.receiptRecord = receiptRecord('open', false);
    expect(evaluate(input)).toMatchObject({ outcome: 'needs_research', outputs: { status: 'escalated', nextAction: 'open-incident-escalation' } });
  });

  it('returns exhausted when the durable ledger refuses another attempt', () => {
    const input = base();
    input.ledgerAdmission = { allowed: false, reason: 'budget-exhausted', failureClass: 'infrastructure', fingerprint: 'a'.repeat(64), attempt: 3 };
    expect(evaluate(input)).toMatchObject({ outcome: 'exhausted', outputs: { status: 'exhausted' } });
  });

  it('fails closed for unavailable network results, mismatched fingerprints, and unredacted evidence', () => {
    const unavailable = base();
    unavailable.repairResult = { status: 'failed' };
    expect(evaluate(unavailable).outcome).toBe('unknown');
    const mismatch = base();
    mismatch.repairResult.receiptRecord = receiptRecord('fixed', true, 'c'.repeat(64));
    expect(evaluate(mismatch).outcome).toBe('unknown');
    expect(evaluate({ ...base(), evidenceReferences: ['receipt:C:\\private\\token.txt'] }).outcome).toBe('unknown');
  });

  it('ignores Hindsight and agent summary claims when deriving the ledger result', () => {
    const input = { ...base(), hindsightSummary: { status: 'recovered', outcome: 'passed' }, agentSummary: 'the repair worked' };
    input.repairResult.receiptRecord = receiptRecord('open', false);
    expect(evaluate(input)).toMatchObject({ outcome: 'blocked', outputs: { status: 'validation_failed' } });
  });

  it('keeps duplicate delivery idempotent by returning the same typed result for the same event identity', () => {
    const first = evaluate(base());
    const duplicate = evaluate(base());
    expect(duplicate).toEqual(first);
    expect(duplicate.outputs.eventId).toBe('event:release:42');
  });

  it('rejects a forged success when the file in the configured receipt store says the probe is still open', () => {
    const input = base();
    const actual = receiptRecord('open', false);
    expect(evaluate(input, actual)).toMatchObject({ outcome: 'unknown', outputs: { reasonCode: 'repair-receipt-does-not-match-store' } });
  });

  it('rejects stale repair receipts', () => {
    const input = base();
    input.repairResult.receiptRecord = { ...(input.repairResult.receiptRecord as object), updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    expect(evaluate(input)).toMatchObject({ outcome: 'unknown', outputs: { reasonCode: 'repair-receipt-stale-or-invalid' } });
  });

  it('fails closed when the configured store or matching ledger event is unavailable', () => {
    expect(evaluateReleaseIncidentWorkflow(base(), undefined)).toMatchObject({ outcome: 'unknown', outputs: { reasonCode: 'release-store-not-configured' } });
    const root = mkdtempSync(join(tmpdir(), 'factory-incident-empty-'));
    roots.push(root);
    expect(evaluateReleaseIncidentWorkflow(base(), root)).toMatchObject({ outcome: 'unknown', outputs: { reasonCode: 'authoritative-release-evidence-unavailable' } });
  });
});
