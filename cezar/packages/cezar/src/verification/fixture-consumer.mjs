import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Deliberately depends only on Node's built-ins. This second consumer pins the JSON vocabulary
// without importing the Zod schemas that produced the fixtures.
export async function consumeVerificationFixtures(directory) {
  const read = async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'));
  const legacy = await read('legacy-valid.json');
  if (!legacy.validation?.changed || !legacy.validation?.full || !legacy.validation?.verify || 'verification' in legacy) {
    throw new Error('legacy validation fixture changed');
  }
  const manifest = await read('v1-valid.json');
  if (manifest.version !== 1 || !manifest.checks?.parse || !manifest.suites?.quick?.includes('parse')) {
    throw new Error('v1 manifest fixture changed');
  }
  for (const file of ['unsupported-version.json', 'duplicate-suite-check.json', 'missing-executable.json', 'unknown-suite-check.json', 'unsafe-cwd.json', 'invalid-timeout.json', 'empty-suite.json']) {
    const bad = await read(file);
    if (bad.version === 1 && bad.checks?.parse?.executable && bad.suites?.quick?.length === 1 && bad.suites.quick[0] === 'parse' && bad.checks.parse.timeoutSeconds >= 1 && bad.checks.parse.timeoutSeconds <= 3600 && !String(bad.checks.parse.cwd ?? '.').startsWith('..')) {
      throw new Error(`malformed fixture unexpectedly looks valid: ${file}`);
    }
  }
  const pass = await read('passing-result.json');
  if (pass.status !== 'passed' || pass.semanticExitCode !== 0) throw new Error('passing result fixture changed');
  const partial = await read('optional-skip-result.json');
  if (partial.status !== 'passed' || partial.coverage.skipped !== 1) throw new Error('optional skip fixture changed');
  const zero = await read('zero-tests-result.json');
  if (zero.status !== 'no-tests' || zero.semanticExitCode !== 2 || zero.checks.length !== 0) {
    throw new Error('zero-test result must remain explicitly non-green');
  }
  const clipped = await read('truncated-result.json');
  if (clipped.status === 'passed' || clipped.checks.some((check) => check.outputTruncated && check.status === 'passed')) {
    throw new Error('truncated evidence was treated as green');
  }
  return { platform: process.platform, fixtures: 13 };
}
