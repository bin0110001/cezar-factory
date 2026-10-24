import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  projectValidationConfigSchema,
  verificationManifestSchema,
  verificationRunSchema,
} from '@open-mercato/cezar-contract';
import { executeCheck, executeSuite, manifestDigest, redactVerificationOutput } from './executor.ts';
// @ts-expect-error This deliberately separate fixture consumer is plain Node ESM with no Cezar imports.
import { consumeVerificationFixtures } from './fixture-consumer.mjs';

const fixtures = new URL('../../../contract/fixtures/verification/', import.meta.url);
const readFixture = async (name: string) => JSON.parse(await readFile(new URL(name, fixtures), 'utf8')) as unknown;
const node = process.execPath;
const command = (args: string[], patch: Partial<{ cwd: string; timeoutSeconds: number; optional: boolean; requires: string[]; resources: string[] }> = {}) => ({
  runner: 'command' as const, executable: node, args, cwd: '.', timeoutSeconds: 2, optional: false, ...patch,
});

describe('verification contract and executor', () => {
  it('accepts legacy validation-only configuration unchanged and parses the v1 fixture', async () => {
    const legacy = await readFixture('legacy-valid.json');
    expect(projectValidationConfigSchema.parse(legacy)).toEqual(legacy);
    expect(verificationManifestSchema.safeParse(await readFixture('v1-valid.json')).success).toBe(true);
    expect(manifestDigest(await readFixture('v1-valid.json'))).toMatch(/^[a-f0-9]{64}$/);
  });

  it('passes the shared fixture corpus through a standalone Node consumer', async () => {
    expect(await consumeVerificationFixtures(fileURLToPath(fixtures))).toMatchObject({ platform: process.platform, fixtures: 13 });
  });

  it.each(['unsupported-version.json', 'duplicate-suite-check.json', 'missing-executable.json', 'unknown-suite-check.json', 'unsafe-cwd.json', 'invalid-timeout.json', 'empty-suite.json'])(
    'rejects malformed fixture %s', async (fixture) => {
      expect(verificationManifestSchema.safeParse(await readFixture(fixture)).success).toBe(false);
    },
  );

  it('accepts passing and optional-skip result fixtures and rejects truncated green output', async () => {
    expect(verificationRunSchema.safeParse(await readFixture('passing-result.json')).success).toBe(true);
    expect(verificationRunSchema.safeParse(await readFixture('optional-skip-result.json')).success).toBe(true);
    const noTests = await readFixture('zero-tests-result.json');
    expect(verificationRunSchema.safeParse(noTests).success).toBe(true);
    const falseGreen = structuredClone(noTests) as { status: string; semanticExitCode: number };
    falseGreen.status = 'passed';
    falseGreen.semanticExitCode = 0;
    expect(verificationRunSchema.safeParse(falseGreen).success).toBe(false);
    const contradictory = structuredClone(await readFixture('passing-result.json')) as {
      checks: Array<{ status: string }>;
    };
    contradictory.checks[0]!.status = 'failed';
    expect(verificationRunSchema.safeParse(contradictory).success).toBe(false);
    const truncated = await readFixture('truncated-result.json');
    expect(verificationRunSchema.safeParse(truncated).success).toBe(true);
    const bad = structuredClone(truncated) as { status: string; checks: Array<{ status: string }> };
    bad.status = 'passed';
    bad.checks[0]!.status = 'passed';
    expect(verificationRunSchema.safeParse(bad).success).toBe(false);
  });

  it('reports optional missing capabilities as skipped and required capabilities as unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cez-verification-'));
    try {
      const optional = await executeCheck('optional', command([], { requires: ['engine'], optional: true }), { projectRoot: root });
      const required = await executeCheck('required', command([], { requires: ['engine'] }), { projectRoot: root });
      expect(optional.status).toBe('skipped');
      expect(required.status).toBe('unknown');
      expect((await executeSuite({ version: 1, checks: { required: command([], { requires: ['engine'] }) }, suites: { full: ['required'] } }, 'full', { projectRoot: root })).status).toBe('unknown');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps launch failures and non-test exit codes out of passed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cez-verification-'));
    try {
      const missing = await executeCheck('missing', { ...command([]), executable: 'cezar-executable-that-does-not-exist' }, { projectRoot: root });
      const crash = await executeCheck('crash', command(['-e', 'process.exit(9)']), { projectRoot: root });
      const noTests = await executeCheck('no-tests', command(['-e', 'process.exit(2)']), { projectRoot: root });
      expect(missing.status).toBe('infrastructure-error');
      expect(crash.status).toBe('infrastructure-error');
      expect(crash.rawExitCode).toBe(9);
      expect(noTests.status).toBe('no-tests');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('times out and cancels child process trees with distinct semantic exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cez-verification-'));
    try {
      const timed = await executeCheck('hang', command(['-e', 'setInterval(() => {}, 1000)'], { timeoutSeconds: 1 }), { projectRoot: root });
      const controller = new AbortController();
      const pending = executeCheck('cancel', command(['-e', 'setInterval(() => {}, 1000)'], { timeoutSeconds: 10 }), { projectRoot: root, signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      const cancelled = await pending;
      expect(timed.status).toBe('infrastructure-error');
      expect(timed.semanticExitCode).toBe(3);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.semanticExitCode).toBe(4);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('isolates concurrent run cwd values, handles spaces, redacts output, and marks clipping unknown', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cez verify parent '));
    const first = join(parent, 'run one');
    const second = join(parent, 'run two');
    await Promise.all([mkdir(first), mkdir(second)]);
    try {
      const [a, b] = await Promise.all([
        executeCheck('a', command(['-e', "console.log(process.cwd()); console.log('token=abc')"]), { projectRoot: first }),
        executeCheck('b', command(['-e', "console.log(process.cwd())"]), { projectRoot: second }),
      ]);
      expect(a.outputPreview).toContain('run one');
      expect(b.outputPreview).toContain('run two');
      expect(a.outputPreview).toContain('token=[REDACTED]');
      const noisy = await executeCheck('noisy', command(['-e', "process.stdout.write('x'.repeat(25000))"]), { projectRoot: first });
      expect(noisy.status).toBe('unknown');
      expect(noisy.outputTruncated).toBe(true);
      expect(noisy.outputPreview.length).toBeLessThanOrEqual(20_000);
      expect(redactVerificationOutput('Authorization: Bearer abc')).toContain('[REDACTED]');
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('rejects cwd traversal and unsupported manifest versions before any child starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cez-verification-'));
    try {
      const escaped = await executeCheck('escape', { ...command([]), cwd: '../' }, { projectRoot: root });
      expect(escaped.status).toBe('unknown');
      const unsupported = await executeSuite({ version: 2, checks: {}, suites: {} }, 'full', { projectRoot: root });
      expect(unsupported.status).toBe('unknown');
      expect(unsupported.semanticExitCode).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
