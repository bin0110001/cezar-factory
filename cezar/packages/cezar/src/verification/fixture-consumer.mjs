import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const expectedStatuses = {
    'failed-result.json': 'failed',
    'required-skip-result.json': 'skipped',
    'no-tests-result.json': 'no-tests',
    'parser-error-result.json': 'unknown',
    'infrastructure-error-result.json': 'infrastructure-error',
    'cancelled-result.json': 'cancelled',
    'truncated-result.json': 'unknown',
    'not-selected-result.json': 'not-selected',
    'partial-selection-passing-result.json': 'passed',
  };
  for (const [file, status] of Object.entries(expectedStatuses)) {
    const result = await read(file);
    if (result.status !== status || (status !== 'passed' && result.semanticExitCode === 0)) throw new Error(`unexpected result semantics: ${file}`);
  }
  return { platform: process.platform, fixtures: 21 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../../../contract/fixtures/verification/', import.meta.url));
  const result = await consumeVerificationFixtures(directory);
  process.stdout.write(`Verification fixtures passed (${result.fixtures}, ${result.platform})\n`);
}
