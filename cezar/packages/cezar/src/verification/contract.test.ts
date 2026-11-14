import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verificationFingerprintStrategySchema, verificationManifestSchema, verificationRunSchema, projectValidationConfigSchema, aggregateRoleEvidence } from '@open-mercato/cezar-contract';

const fixtures = new URL('../../../contract/fixtures/verification/', import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));

describe('versioned verification contracts', () => {
  it('validates fingerprint strategy descriptors', () => {
    expect(verificationFingerprintStrategySchema.safeParse({
      id: 'cezar.verification.test-failure', version: 1, kinds: ['test-failure'],
    }).success).toBe(true);
    expect(verificationFingerprintStrategySchema.safeParse({ id: 'x', version: 0, kinds: [] }).success).toBe(false);
  });

  it('preserves legacy validation config unchanged', async () => {
    const legacy = await read('legacy-valid.json');
    expect(projectValidationConfigSchema.parse(legacy)).toEqual(legacy);
  });

  it('accepts the v1 manifest and rejects malformed fixtures', async () => {
    expect(verificationManifestSchema.safeParse(await read('v1-valid.json')).success).toBe(true);
    for (const name of ['unsupported-version.json', 'duplicate-suite-check.json', 'missing-executable.json', 'unknown-suite-check.json', 'unsafe-cwd.json', 'invalid-timeout.json', 'empty-suite.json']) {
      expect(verificationManifestSchema.safeParse(await read(name)).success, name).toBe(false);
    }
  });

  it('accepts conclusive results and fails closed for incomplete evidence', async () => {
    for (const name of ['passing-result.json', 'optional-skip-result.json', 'truncated-result.json', 'failed-result.json', 'required-skip-result.json', 'no-tests-result.json', 'parser-error-result.json', 'infrastructure-error-result.json', 'cancelled-result.json']) {
      const result = await read(name);
      expect(verificationRunSchema.safeParse(result).success, name).toBe(true);
    }
    expect(verificationRunSchema.safeParse(await read('invalid-artifact-result.json')).success).toBe(false);
    const passing = await read('passing-result.json');
    const requiredSkip = structuredClone(passing);
    requiredSkip.checks[0].status = 'skipped';
    requiredSkip.checks[0].semanticExitCode = 2;
    requiredSkip.checks[0].coverage = { selected: 1, passed: 0, skipped: 1 };
    requiredSkip.coverage = { selected: 1, passed: 0, failed: 0, skipped: 1, unknown: 0 };
    expect(verificationRunSchema.safeParse(requiredSkip).success).toBe(false);
    const fabricatedPass = structuredClone(passing);
    fabricatedPass.checks[0].status = 'unknown';
    fabricatedPass.checks[0].semanticExitCode = 2;
    fabricatedPass.checks[0].coverage = { selected: 1, passed: 0, skipped: 0 };
    expect(verificationRunSchema.safeParse(fabricatedPass).success).toBe(false);
    const versionedFinding = structuredClone(passing);
    versionedFinding.checks[0].findingFingerprint = 'b'.repeat(64);
    versionedFinding.checks[0].findingStrategyId = 'cezar.verification.test-failure';
    versionedFinding.checks[0].findingStrategyVersion = 1;
    expect(verificationRunSchema.safeParse(versionedFinding).success).toBe(true);
    const partialStrategy = structuredClone(passing);
    partialStrategy.checks[0].findingStrategyId = 'cezar.verification.test-failure';
    expect(verificationRunSchema.safeParse(partialStrategy).success).toBe(false);
  });

  it('binds optional visual evidence to its exact verification run, attempt, test and artifact', async () => {
    const visual = await read('visual-evidence-valid.json');
    expect(verificationRunSchema.safeParse(visual).success).toBe(true);
    const headless = await read('passing-result.json');
    expect(verificationRunSchema.safeParse(headless).success).toBe(true);
    expect(headless.checks[0].artifacts).toEqual([]);
    const mixedAttempt = await read('visual-evidence-cross-attempt.json');
    expect(verificationRunSchema.safeParse(mixedAttempt).success).toBe(false);
    const mixedCommit = structuredClone(visual);
    mixedCommit.checks[0].artifacts[0].visualEvidence.commitSha = 'f'.repeat(40);
    expect(verificationRunSchema.safeParse(mixedCommit).success).toBe(false);
    const mixedHash = structuredClone(visual);
    mixedHash.checks[0].artifacts[0].visualEvidence.contentSha256 = 'd'.repeat(64);
    expect(verificationRunSchema.safeParse(mixedHash).success).toBe(false);
    const unboundRunArtifact = structuredClone(visual);
    unboundRunArtifact.artifacts = [unboundRunArtifact.checks[0].artifacts[0]];
    expect(verificationRunSchema.safeParse(unboundRunArtifact).success).toBe(false);
  });

  it('validates fixtures with an independent Node-only consumer', async () => {
    const consumer = fileURLToPath(new URL('./fixture-consumer.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [consumer, fileURLToPath(fixtures)], { encoding: 'utf8' });
    expect(output).toContain('Verification fixtures passed (21,');
  });

  describe('multi-role visual evidence aggregation', () => {
    const base = {
      version: 1 as const, kind: 'png' as const, verificationId: 'v1', attempt: 1, sessionId: 's1', testId: 't',
      commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), policyVersion: 'p', capturedAt: '2026-01-01T00:00:00.000Z',
      retention: 'r', accessPolicy: 'private' as const, redactionState: 'redacted' as const, storageReference: 'a.png',
      renderer: { os: 'linux', resolution: { width: 1, height: 1 }, dpi: 96, displayBackend: 'x', renderer: 'software' as const, graphicsApi: null, driver: null, appVersion: '1', colorSettings: {}, renderFeatures: [] },
    };
    const ev = (role: string, checkpointId: string, n: string, extra: object = {}) => ({ ...base, role, checkpointId, contentSha256: n.repeat(64), workerFingerprint: `host-${role}`, ...extra });
    const run = (evidence: ReturnType<typeof ev>[], extra: object = {}) => aggregateRoleEvidence({
      verificationId: 'v1', attempt: 1, sessionId: 's1',
      expected: [{ role: 'host', checkpoints: ['c1'] }, { role: 'client', checkpoints: ['c1'] }], evidence, ...extra,
    });

    it('maps two-host artifacts to roles and checkpoints regardless of order or timestamps', () => {
      const result = run([ev('client', 'c1', 'd', { capturedAt: '2020-01-01T00:00:00.000Z' }), ev('host', 'c1', 'c')]);
      expect(result.status).toBe('passed');
      expect(result.roles.find((r) => r.role === 'host')!.checkpoints.c1!.sha256).toBe('c'.repeat(64));
      expect(result.roles.find((r) => r.role === 'client')!.checkpoints.c1!.sha256).toBe('d'.repeat(64));
    });
    it('is incomplete when a role is missing and not masked by a passing sibling', () => {
      const result = run([ev('host', 'c1', 'c')]);
      expect(result.status).toBe('incomplete');
      expect(result.roles.find((r) => r.role === 'client')!.status).toBe('incomplete');
    });
    it('fails on a failed role and reports infrastructure-error on disconnect', () => {
      const both = [ev('host', 'c1', 'c'), ev('client', 'c1', 'd')];
      expect(run(both, { failedRoles: ['client'] }).status).toBe('failed');
      expect(run(both, { disconnectedRoles: ['client'] }).status).toBe('infrastructure-error');
    });
    it('rejects cross-attempt, cross-session, unknown-checkpoint and conflicting duplicate evidence', () => {
      const result = run([ev('host', 'c1', 'c', { attempt: 2 }), ev('client', 'c1', 'd', { sessionId: 's0' }), ev('host', 'zz', 'e')]);
      expect(result.status).toBe('incomplete');
      expect(result.roles[0].rejected.map((r) => r.reason)).toEqual(['stale-attempt', 'unknown-role-or-checkpoint']);
      const dup = run([ev('host', 'c1', 'c'), ev('host', 'c1', 'e'), ev('client', 'c1', 'd')]);
      expect(dup.status).toBe('incomplete');
      expect(run([ev('host', 'c1', 'c'), ev('host', 'c1', 'c'), ev('client', 'c1', 'd')]).status).toBe('passed');
    });
  });
});
