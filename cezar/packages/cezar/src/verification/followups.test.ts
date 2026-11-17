import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FindingAuditLog } from './finding-ingest.ts';
import {
  DEFAULT_BUDGET, ensureFollowUp, followUpBody, followUpKey, keyMarker, nextRemediation, recordRemediation, remediationDigest, type FollowUpFacts, type Publisher,
} from './followups.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'followups-')); roots.push(d); return d; };

const fp = (n: number) => n.toString(16).padStart(64, '0');
const facts = (n = 1, over: Partial<FollowUpFacts> = {}): FollowUpFacts => ({ fingerprint: fp(n), checkId: 'dependency-scan', severity: 'critical', title: `[quality] critical CVE-2026-000${n}`, path: 'package-lock.json', advisoryId: `CVE-2026-000${n}`, fixAvailable: true, ...over });

class FakePublisher implements Publisher {
  issues: Array<{ number: number; key: string; title: string; body: string; labels: string[] }> = [];
  creates = 0;
  async find(key: string) { const i = this.issues.find((x) => x.body.includes(keyMarker(key))); return i ? { number: i.number } : undefined; }
  async create(input: { key: string; title: string; body: string; labels: string[] }) { this.creates++; const number = 100 + this.issues.length; this.issues.push({ number, ...input }); return { number }; }
}
const opts = { actor: 'verification', now: '2026-11-10T00:00:00.000Z' };

describe('idempotent follow-ups', () => {
  it('repeated findings across many executions produce exactly one issue', async () => {
    const audit = new FindingAuditLog(dir(), 'p');
    const pub = new FakePublisher();
    const first = await ensureFollowUp(audit, pub, 'p', facts(), opts);
    for (let i = 0; i < 25; i++) await ensureFollowUp(audit, pub, 'p', facts(), opts);
    expect(first).toMatchObject({ created: true, source: 'created', issueNumber: 100 });
    expect(pub.creates).toBe(1);
    expect(pub.issues).toHaveLength(1);
    expect(audit.history().filter((e) => e.type === 'followup-recorded')).toHaveLength(1);
  });

  it('a different finding gets its own issue; the body carries the key marker and the fix guidance', async () => {
    const audit = new FindingAuditLog(dir(), 'p');
    const pub = new FakePublisher();
    await ensureFollowUp(audit, pub, 'p', facts(1), opts);
    await ensureFollowUp(audit, pub, 'p', facts(2, { fixAvailable: false }), opts);
    expect(pub.issues).toHaveLength(2);
    expect(pub.issues[0]!.body).toContain(keyMarker(followUpKey('p', fp(1))));
    expect(pub.issues[0]!.body).toContain('upgrade or patch');
    expect(pub.issues[1]!.body).toContain('request a reviewed waiver');
    expect(followUpBody(facts(1), 'k')).toContain('<!-- k -->');
  });

  it('concurrent callers for the same finding share one creation', async () => {
    const audit = new FindingAuditLog(dir(), 'p');
    const pub = new FakePublisher();
    const results = await Promise.all(Array.from({ length: 10 }, () => ensureFollowUp(audit, pub, 'p', facts(), opts)));
    expect(pub.creates).toBe(1);
    expect(new Set(results.map((r) => r.issueNumber)).size).toBe(1);
  });

  it('replay after a crash between creating the issue and recording it is a no-op for the publisher', async () => {
    const d = dir();
    const pub = new FakePublisher();
    // the crashed run created the issue (marker in the body) but never wrote the ledger event
    await pub.create({ key: followUpKey('p', fp(1)), title: 't', body: followUpBody(facts(), followUpKey('p', fp(1))), labels: [] });
    const audit = new FindingAuditLog(d, 'p');
    const recovered = await ensureFollowUp(audit, pub, 'p', facts(), opts);
    expect(recovered).toMatchObject({ created: false, source: 'publisher-existing', issueNumber: 100 });
    expect(pub.creates).toBe(1);
    // and a fresh process reading the same ledger sees it recorded
    const again = await ensureFollowUp(new FindingAuditLog(d, 'p'), pub, 'p', facts(), opts);
    expect(again.source).toBe('ledger');
    expect(pub.creates).toBe(1);
  });

  it('is scoped per project: the same fingerprint in another project is a separate follow-up', async () => {
    const pub = new FakePublisher();
    await ensureFollowUp(new FindingAuditLog(dir(), 'p'), pub, 'p', facts(), opts);
    await ensureFollowUp(new FindingAuditLog(dir(), 'q'), pub, 'q', facts(), opts);
    expect(pub.issues).toHaveLength(2);
  });
});

describe('bounded remediation', () => {
  const f = (over: Record<string, boolean> = {}) => ({ fingerprint: fp(1), autoFixable: true, agentReachable: true, trulyBlocked: false, ...over });

  it('climbs the ladder one recorded step at a time and stops at the budget', () => {
    const audit = new FindingAuditLog(dir(), 'p');
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const plan = nextRemediation(audit, f());
      if (plan.step === 'done') { seen.push(`done:${plan.exhausted}`); break; }
      seen.push(plan.step);
      recordRemediation(audit, 'p', { fingerprint: fp(1), step: plan.step, attempt: plan.attempt, outcome: 'failed', actor: 'a', now: '2026-11-10T00:00:00Z' });
    }
    expect(seen).toEqual(['auto-fix', 'return-to-agent', 'scoped-rerun', 'planning-escalation', 'done:true']);
  });

  it('skips steps that do not apply and only asks a human when truly blocked', () => {
    const audit = new FindingAuditLog(dir(), 'p');
    expect(nextRemediation(audit, f({ autoFixable: false })).step).toBe('return-to-agent');
    expect(nextRemediation(audit, f({ autoFixable: false, agentReachable: false })).step).toBe('scoped-rerun');
    const budget = { attemptsPerStep: 1, maxTotalAttempts: 1 };
    recordRemediation(audit, 'p', { fingerprint: fp(1), step: 'auto-fix', attempt: 1, outcome: 'failed', actor: 'a', now: '2026-11-10T00:00:00Z' });
    expect(nextRemediation(audit, f(), budget)).toMatchObject({ step: 'done', exhausted: true });
    const blocked = nextRemediation(audit, f({ trulyBlocked: true }), budget);
    expect(blocked).toMatchObject({ step: 'human-decision', exhausted: true });
    recordRemediation(audit, 'p', { fingerprint: fp(1), step: 'human-decision', attempt: 1, outcome: 'opened', actor: 'a', now: '2026-11-10T00:00:00Z' });
    expect(nextRemediation(audit, f({ trulyBlocked: true }), budget).step).toBe('done'); // exactly one persistent decision task
  });

  it('a successful fix ends remediation', () => {
    const audit = new FindingAuditLog(dir(), 'p');
    recordRemediation(audit, 'p', { fingerprint: fp(1), step: 'auto-fix', attempt: 1, outcome: 'fixed', actor: 'a', now: '2026-11-10T00:00:00Z' });
    expect(nextRemediation(audit, f())).toMatchObject({ step: 'done', reason: 'already remediated' });
  });

  it('replay after a crash is a no-op: the same step is not recorded twice and the plan and digest are unchanged', () => {
    const d = dir();
    const audit = new FindingAuditLog(d, 'p');
    const step = { fingerprint: fp(1), step: 'auto-fix' as const, attempt: 1, outcome: 'failed', actor: 'a', now: '2026-11-10T00:00:00Z' };
    expect(recordRemediation(audit, 'p', step).recorded).toBe(true);
    const digest = remediationDigest(audit, fp(1));
    const planBefore = nextRemediation(audit, f());
    expect(recordRemediation(audit, 'p', step).recorded).toBe(false);
    const restarted = new FindingAuditLog(d, 'p');
    expect(recordRemediation(restarted, 'p', step).recorded).toBe(false);
    expect(remediationDigest(restarted, fp(1))).toBe(digest);
    expect(nextRemediation(restarted, f())).toEqual(planBefore);
    expect(restarted.history().filter((e) => e.type === 'remediation-recorded')).toHaveLength(1);
    expect(restarted.verifyReplay()).toBe(true);
    expect(DEFAULT_BUDGET.maxTotalAttempts).toBeGreaterThan(0);
  });
});
