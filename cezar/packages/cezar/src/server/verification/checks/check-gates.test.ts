import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema, type CheckDefinition } from './check-provider.js';
import { runCheck, type CheckProviderPlugin, type PluginRunOutput } from './check-runner.js';
import { evaluateGates, planDueChecks, queryRecordFindings, type CheckRunRecord, type GateRequirement } from './check-gates.js';

const SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-16T12:00:00Z');
const FRESH = '2026-11-16T00:00:00Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const def = (name: string, over: Record<string, unknown> = {}): CheckDefinition => checkProviderConfigSchema.parse({ version: 1, checks: [{
  id: `${name}-sca`, category: 'sca', provider: { name, version: '1', digest: DIGEST }, scopes: ['full-repo'], triggers: ['pr-dev', 'periodic-independent', 'manual'],
  schedule: { cron: '0 3 * * *', timezone: 'UTC' }, policy: { mandatory: true, timeoutMs: 1000, maxAgeHours: 48 }, ...over,
}] }).checks[0]!;
const plugin = (doc: PluginRunOutput): CheckProviderPlugin => ({ run: async () => doc });
const vulnerable: PluginRunOutput = { format: 'json', dbUpdatedAt: FRESH, document: { findings: [{ id: 'CVE-2021-23337', severity: 'high', package: 'lodash', ecosystem: 'npm' }] } };
const clean: PluginRunOutput = { format: 'json', dbUpdatedAt: FRESH, document: { findings: [] } };

async function record(name: string, out: PluginRunOutput, over: Partial<CheckRunRecord> = {}): Promise<CheckRunRecord> {
  const d = def(name);
  const o = await runCheck({ definition: d, plugin: plugin(out), sourceSha: SHA, scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW });
  return { checkId: d.id, category: d.category, result: o.result, sourceSha: SHA, finishedAt: NOW.toISOString(), findings: o.findings, ...over };
}
const req: GateRequirement[] = [{ category: 'sca', mandatory: true, maxAgeHours: 24 }];

describe('gates', () => {
  it('fake Trivy/Semgrep/custom satisfy the same gate and verdicts carry no provider names', async () => {
    for (const name of ['fake-trivy', 'fake-semgrep', 'custom']) {
      const ev = evaluateGates(req, [await record(name, clean)], { sourceSha: SHA, now: NOW });
      expect(ev.allowed).toBe(true);
      expect(JSON.stringify(ev)).not.toContain(name);
    }
  });
  it('swapping the provider leaves the evaluation unchanged', async () => {
    const a = evaluateGates(req, [await record('fake-trivy', vulnerable)], { sourceSha: SHA, now: NOW });
    const b = evaluateGates(req, [await record('fake-semgrep', vulnerable)], { sourceSha: SHA, now: NOW });
    expect(a).toEqual(b);
    expect(a.allowed).toBe(false);
  });
  it('blocks on missing, stale, other-source and non-passing mandatory results', async () => {
    const ok = await record('p', clean);
    expect(evaluateGates(req, [], { sourceSha: SHA, now: NOW })).toMatchObject({ allowed: false, blocking: ['sca'] });
    expect(evaluateGates(req, [{ ...ok, finishedAt: '2026-11-10T00:00:00Z' }], { sourceSha: SHA, now: NOW }).verdicts[0]!.reasons).toContain('stale');
    expect(evaluateGates(req, [{ ...ok, sourceSha: 'd'.repeat(40) }], { sourceSha: SHA, now: NOW }).verdicts[0]!.reasons).toContain('wrong-source');
    const unknown = await record('p', { ...clean, dbUpdatedAt: '2026-11-01T00:00:00Z' });
    expect(unknown.result.status).toBe('unknown');
    expect(evaluateGates(req, [unknown], { sourceSha: SHA, now: NOW }).allowed).toBe(false);
  });
  it('does not block on an optional category', async () => {
    const ev = evaluateGates([{ category: 'sca', mandatory: false, maxAgeHours: 24 }], [], { sourceSha: SHA, now: NOW });
    expect(ev.allowed).toBe(true);
    expect(ev.verdicts[0]!.satisfied).toBe(false);
  });
  it('answers one findings query across providers', async () => {
    const recs = [await record('fake-trivy', vulnerable), await record('fake-semgrep', vulnerable)];
    expect(queryRecordFindings(recs, { severity: ['high'] })).toHaveLength(1);
  });
});

describe('independent schedule', () => {
  const defs = [def('a'), def('b', { triggers: ['pr-dev'] })];
  it('lists periodic checks only when never run or aged out, and produces no candidate', () => {
    const due = planDueChecks(defs, {}, 'periodic-independent', NOW);
    expect(due).toEqual([{ checkId: 'a-sca', trigger: 'periodic-independent' }]);
    expect(Object.keys(due[0]!)).toEqual(['checkId', 'trigger']);
    expect(planDueChecks(defs, { 'a-sca': '2026-11-16T06:00:00Z' }, 'periodic-independent', NOW)).toEqual([]);
    expect(planDueChecks(defs, { 'a-sca': '2026-11-10T00:00:00Z' }, 'periodic-independent', NOW)).toHaveLength(1);
  });
  it('manual and risk-event triggers run on demand for checks that allow them', () => {
    expect(planDueChecks(defs, { 'a-sca': NOW.toISOString() }, 'manual', NOW)).toHaveLength(1);
    expect(planDueChecks(defs, {}, 'risk-event', NOW)).toEqual([]);
  });
});
