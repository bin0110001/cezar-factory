import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProviderConfigSchema } from '../server/verification/checks/check-provider.ts';
import { swapProvider } from '../server/verification/checks/guards.ts';
import { runCheck, type CheckProviderPlugin } from '../server/verification/checks/check-runner.ts';
import { osvPlugin } from '../server/verification/checks/providers/osv-adapter.ts';
import { trivyPlugin } from '../server/verification/checks/providers/trivy-adapter.ts';
import { toIngestInput, type BridgeContext } from './check-bridge.ts';
import { ingestCheckFindings } from './check-finding-ingest.ts';
import { baselineFromFindings } from './disposition.ts';
import { FindingAuditLog } from './finding-ingest.ts';
import { FileFindingLedgerStore } from './finding-ledger.ts';

/** Provider swap by configuration (#673): history survives because findings use the provider-independent fingerprint. */

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-16T12:00:00Z');
const FRESH = '2026-11-16T00:00:00Z';

const trivyJson = JSON.stringify({ Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Vulnerabilities: [{ VulnerabilityID: 'CVE-2021-0001', PkgName: 'lodash', InstalledVersion: '4.17.20', FixedVersion: '4.17.21', Severity: 'HIGH', Title: 'injection' }] }] });
const osvJson = JSON.stringify({ results: [{ source: { path: 'package-lock.json' }, packages: [{ package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
  vulnerabilities: [{ id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-0001'], summary: 'injection', affected: [{ package: { name: 'lodash' }, ranges: [{ events: [{ fixed: '4.17.21' }] }] }] }], groups: [{ ids: ['GHSA-35jh-r3h4-6jhm'], max_severity: '7.5' }] }] }] });

function make(provider: string, plugin: CheckProviderPlugin) {
  let defs = checkProviderConfigSchema.parse({ version: 1, checks: [{
    id: 'dependency-scan', category: 'sca', provider: { name: 'trivy', version: '1', digest: DIGEST }, scopes: ['full-repo'], triggers: ['pr-dev'], policy: { mandatory: true, timeoutMs: 1000, maxAgeHours: 48 },
  }] }).checks;
  defs = swapProvider(defs, 'dependency-scan', { name: provider, version: '2', digest: DIGEST });
  return runCheck({ definition: defs[0]!, plugin, sourceSha: 'c'.repeat(40), scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW });
}

const ctx = (id: string): BridgeContext => ({
  projectId: 'p', verificationId: id, runId: 'r', commitSha: 'c'.repeat(40), environment: { os: 'linux' }, observedAt: `2026-11-16T12:0${id.length}:00.000Z`,
  baseline: baselineFromFindings([], { source: 'integration', sha: 'a'.repeat(40), envFingerprint: 'e', at: '2026-11-01T00:00:00Z' }),
  baseSha: 'b'.repeat(40), envFingerprint: 'e', policyVersion: 'p1', actor: 'ci',
});

describe('swapping the scan provider by configuration', () => {
  it('keeps one finding, its episode and its history across Trivy then OSV-Scanner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swap-'));
    roots.push(dir);
    const store = FileFindingLedgerStore.open(dir, 'p', { now: () => NOW });
    const audit = new FindingAuditLog(dir, 'p');

    const viaTrivy = await make('trivy', trivyPlugin({ domain: 'repository', target: '/src', readDbUpdatedAt: async () => FRESH, exec: async () => ({ exitCode: 0, stdout: trivyJson }) }));
    const first = ingestCheckFindings(store, audit, toIngestInput(viaTrivy, ctx('v1')));
    const viaOsv = await make('osv-scanner', osvPlugin({ domain: 'repository', target: '/src', readDbUpdatedAt: async () => FRESH, exec: async () => ({ exitCode: 1, stdout: osvJson }) }));
    const second = ingestCheckFindings(store, audit, toIngestInput(viaOsv, ctx('v22')));

    expect(viaTrivy.findings[0]!.fingerprint).toBe(viaOsv.findings[0]!.fingerprint);
    const snap = store.snapshot();
    expect(snap.findings).toHaveLength(1);                         // no second finding: history is kept
    expect(snap.episodes.filter((e) => e.status === 'open')).toHaveLength(1);
    expect(snap.occurrences).toHaveLength(2);                      // one observation per provider run
    expect(first.opened).toHaveLength(1);
    expect(second.appended).toHaveLength(1);
    expect(second.dispositions.summary.known + second.dispositions.summary.new).toBeGreaterThan(0);
    expect(viaTrivy.provenance.providerName).toBe('trivy');
    expect(viaOsv.provenance.providerName).toBe('osv-scanner');     // provenance still says who produced each observation
    expect(audit.verifyReplay()).toBe(true);
  });
});
