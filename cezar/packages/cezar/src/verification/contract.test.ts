import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verificationManifestSchema, verificationRunSchema, projectValidationConfigSchema } from '@open-mercato/cezar-contract';

const fixtures = new URL('../../../contract/fixtures/verification/', import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));

describe('versioned verification contracts', () => {
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

  it('accepts the shared two-hour verification ceiling and rejects values above it', async () => {
    const manifest = await read('v1-valid.json');
    manifest.checks.parse.timeoutSeconds = 7_200;
    expect(verificationManifestSchema.safeParse(manifest).success).toBe(true);
    manifest.checks.parse.timeoutSeconds = 7_201;
    expect(verificationManifestSchema.safeParse(manifest).success).toBe(false);
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
  });

  it('validates fixtures with an independent Node-only consumer', async () => {
    const consumer = fileURLToPath(new URL('./fixture-consumer.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [consumer, fileURLToPath(fixtures)], { encoding: 'utf8' });
    expect(output).toContain('Verification fixtures passed (19,');
  });
});
