import { z } from 'zod';

export const VERIFICATION_LIMITS = {
  checksPerRun: 256,
  timeoutSeconds: { min: 1, max: 3_600 },
  outputCharsPerCheck: 20_000,
  diagnosticsPerCheck: 200,
  diagnosticMessageChars: 2_000,
  metricsPerCheck: 128,
  artifactRefsPerRun: 100,
  resultBytes: 1_048_576,
} as const;

const relativePathSchema = z.string().min(1).max(1_024).refine((path) => {
  if (path === '.') return true;
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0);
}, 'must be a normalized relative path');

const verificationCheckSchema = z.object({
  runner: z.literal('command'),
  executable: z.string().trim().min(1).max(512),
  args: z.array(z.string().max(4_096)).max(256),
  cwd: relativePathSchema.default('.'),
  timeoutSeconds: z.number().int().min(1).max(3_600),
  tags: z.array(z.string().min(1).max(64)).max(64).optional(),
  owns: z.array(z.string().min(1).max(256)).max(128).optional(),
  requires: z.array(z.string().min(1).max(128)).max(128).optional(),
  optional: z.boolean().default(false),
  resources: z.array(z.string().min(1).max(128)).max(64).optional(),
}).strict();

export const verificationManifestSchema = z.object({
  version: z.literal(1),
  checks: z.record(z.string().trim().min(1).max(128), verificationCheckSchema)
    .refine((checks) => Object.keys(checks).length <= VERIFICATION_LIMITS.checksPerRun, 'too many checks'),
  suites: z.record(z.string().trim().min(1).max(128), z.array(z.string().trim().min(1).max(128)).min(1)
    .max(VERIFICATION_LIMITS.checksPerRun)),
}).strict().superRefine((manifest, ctx) => {
  for (const [suite, ids] of Object.entries(manifest.suites)) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['suites', suite], message: `duplicate check ${id}` });
      seen.add(id);
      if (!(id in manifest.checks)) ctx.addIssue({ code: 'custom', path: ['suites', suite], message: `unknown check ${id}` });
    }
  }
});
export type VerificationManifest = z.infer<typeof verificationManifestSchema>;

export const verificationStatusSchema = z.enum([
  'passed', 'failed', 'skipped', 'no-tests', 'unknown', 'infrastructure-error', 'cancelled', 'not-selected',
]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const verificationDiagnosticSchema = z.object({
  code: z.string().min(1).max(128),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().max(VERIFICATION_LIMITS.diagnosticMessageChars),
  file: relativePathSchema.optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
}).strict();

export const verificationMetricSchema = z.object({
  name: z.string().min(1).max(128),
  value: z.number().finite(),
  unit: z.string().max(64).optional(),
  samples: z.number().int().positive().optional(),
  method: z.string().max(128).optional(),
}).strict();

export const verificationArtifactRefSchema = z.object({
  path: relativePathSchema,
  mediaType: z.string().min(1).max(128),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const verificationCheckRunSchema = z.object({
  checkId: z.string().min(1).max(128),
  required: z.boolean(),
  attempt: z.number().int().positive(),
  status: verificationStatusSchema,
  rawExitCode: z.number().int().nullable(),
  semanticExitCode: z.number().int().min(0).max(4),
  durationMs: z.number().int().nonnegative(),
  outputPreview: z.string().max(VERIFICATION_LIMITS.outputCharsPerCheck),
  outputTruncated: z.boolean(),
  diagnostics: z.array(verificationDiagnosticSchema).max(VERIFICATION_LIMITS.diagnosticsPerCheck),
  metrics: z.array(verificationMetricSchema).max(VERIFICATION_LIMITS.metricsPerCheck),
  coverage: z.object({ selected: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict(),
  findingFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  artifacts: z.array(verificationArtifactRefSchema).max(VERIFICATION_LIMITS.artifactRefsPerRun),
}).strict();
export type VerificationCheckRun = z.infer<typeof verificationCheckRunSchema>;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const verificationRunSchema = z.object({
  resultVersion: z.literal(1),
  verificationId: z.string().min(1).max(128),
  cezarRunId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(256),
  worktreeId: z.string().min(1).max(256),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  toolVersions: z.record(z.string(), z.string().max(256)),
  environment: z.record(z.string(), z.string().max(256)),
  status: verificationStatusSchema,
  semanticExitCode: z.number().int().min(0).max(4),
  coverage: z.object({ selected: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
  checks: z.array(verificationCheckRunSchema).max(VERIFICATION_LIMITS.checksPerRun),
  artifacts: z.array(verificationArtifactRefSchema).max(VERIFICATION_LIMITS.artifactRefsPerRun),
}).strict().superRefine((run, ctx) => {
  if (utf8ByteLength(JSON.stringify(run)) > VERIFICATION_LIMITS.resultBytes) {
    ctx.addIssue({ code: 'custom', message: 'serialized result exceeds 1 MiB' });
  }
  const seen = new Set<string>();
  for (const check of run.checks) {
    if (seen.has(check.checkId)) ctx.addIssue({ code: 'custom', path: ['checks'], message: `duplicate check result ${check.checkId}` });
    seen.add(check.checkId);
    if (check.outputTruncated && check.status !== 'unknown') ctx.addIssue({ code: 'custom', path: ['checks'], message: 'truncated output must be unknown' });
    const expectedExit = check.status === 'passed' ? 0
      : check.status === 'failed' ? 1
        : check.status === 'infrastructure-error' ? 3
          : check.status === 'cancelled' ? 4 : 2;
    if (check.semanticExitCode !== expectedExit || (check.status === 'passed' && check.rawExitCode !== 0)) {
      ctx.addIssue({ code: 'custom', path: ['checks'], message: `check ${check.checkId} status and exit codes disagree` });
    }
    const expectedSelected = check.status === 'not-selected' ? 0 : 1;
    const expectedPassed = check.status === 'passed' ? 1 : 0;
    const expectedSkipped = check.status === 'skipped' ? 1 : 0;
    if (check.coverage.selected !== expectedSelected || check.coverage.passed !== expectedPassed || check.coverage.skipped !== expectedSkipped) {
      ctx.addIssue({ code: 'custom', path: ['checks'], message: `check ${check.checkId} coverage disagrees with its status` });
    }
  }
  const actualCoverage = run.checks.reduce((coverage, check) => {
    if (check.status === 'passed') coverage.passed += 1;
    else if (check.status === 'failed') coverage.failed += 1;
    else if (check.status === 'skipped') coverage.skipped += 1;
    else coverage.unknown += 1;
    return coverage;
  }, { passed: 0, failed: 0, skipped: 0, unknown: 0 });
  if (
    run.coverage.selected !== run.checks.length ||
    run.coverage.passed !== actualCoverage.passed ||
    run.coverage.failed !== actualCoverage.failed ||
    run.coverage.skipped !== actualCoverage.skipped ||
    run.coverage.unknown !== actualCoverage.unknown
  ) {
    ctx.addIssue({ code: 'custom', path: ['coverage'], message: 'coverage must match the status of every selected check exactly once' });
  }
  if (run.status === 'passed' && (
    run.coverage.selected === 0 || run.checks.length === 0 ||
    !run.checks.some((check) => check.required) ||
    run.checks.some((check) => check.required && check.status !== 'passed') ||
    run.checks.some((check) => check.status !== 'passed' && check.status !== 'skipped') ||
    run.coverage.failed > 0 || run.coverage.unknown > 0 ||
    run.coverage.selected !== run.coverage.passed + run.coverage.skipped ||
    run.semanticExitCode !== 0
  )) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'passed requires at least one selected check and conclusive required-check coverage' });
  }
  const expectedRunExit = run.status === 'passed' ? 0
    : run.status === 'failed' ? 1
      : run.status === 'infrastructure-error' ? 3
        : run.status === 'cancelled' ? 4 : 2;
  if (run.semanticExitCode !== expectedRunExit) {
    ctx.addIssue({ code: 'custom', path: ['semanticExitCode'], message: 'run status and semantic exit code disagree' });
  }
  if (run.status === 'failed' && !run.checks.some((check) => check.required && check.status === 'failed')) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'failed requires a failed required check' });
  }
  if (run.status === 'infrastructure-error' && !run.checks.some((check) => check.required && check.status === 'infrastructure-error')) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'infrastructure-error requires a required check infrastructure error' });
  }
  if (run.status === 'cancelled' && !run.checks.some((check) => check.required && check.status === 'cancelled')) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'cancelled requires a cancelled required check' });
  }
  if (run.status === 'no-tests' && run.checks.length > 0 && !run.checks.some((check) => check.required && check.status === 'no-tests')) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'no-tests requires an empty selection or a required check with no tests' });
  }
  if (run.status === 'not-selected' && run.checks.length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'not-selected cannot contain selected check results' });
  }
});
export type VerificationRun = z.infer<typeof verificationRunSchema>;

/** Compatibility boundary: old validation-only projects continue on the legacy adapter path. */
export const projectValidationConfigSchema = z.object({
  validation: z.object({ changed: z.string().optional(), full: z.string().optional(), verify: z.string().optional() }).optional(),
  verification: z.unknown().optional(),
}).passthrough();
