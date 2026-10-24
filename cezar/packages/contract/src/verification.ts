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
  const observed = { selected: 0, passed: 0, failed: 0, skipped: 0, unknown: 0 };
  for (const check of run.checks) {
    if (seen.has(check.checkId)) ctx.addIssue({ code: 'custom', path: ['checks'], message: `duplicate check result ${check.checkId}` });
    seen.add(check.checkId);
    if (check.outputTruncated && check.status !== 'unknown') ctx.addIssue({ code: 'custom', path: ['checks'], message: 'truncated output must be unknown' });
    if (check.status === 'passed' && check.semanticExitCode !== 0) ctx.addIssue({ code: 'custom', path: ['checks'], message: `passed check ${check.checkId} must have semantic exit 0` });
    if (check.status === 'failed' && check.semanticExitCode !== 1) ctx.addIssue({ code: 'custom', path: ['checks'], message: `failed check ${check.checkId} must have semantic exit 1` });
    if (check.status === 'unknown' && check.semanticExitCode !== 2) ctx.addIssue({ code: 'custom', path: ['checks'], message: `unknown check ${check.checkId} must have semantic exit 2` });
    if (check.status === 'infrastructure-error' && check.semanticExitCode !== 3) ctx.addIssue({ code: 'custom', path: ['checks'], message: `infrastructure error ${check.checkId} must have semantic exit 3` });
    if (check.status === 'cancelled' && check.semanticExitCode !== 4) ctx.addIssue({ code: 'custom', path: ['checks'], message: `cancelled check ${check.checkId} must have semantic exit 4` });
    const expectedCheckCoverage = check.status === 'passed' ? [1, 1, 0] : check.status === 'skipped' ? [1, 0, 1] : [1, 0, 0];
    if (check.coverage.selected !== expectedCheckCoverage[0] || check.coverage.passed !== expectedCheckCoverage[1] || check.coverage.skipped !== expectedCheckCoverage[2]) {
      ctx.addIssue({ code: 'custom', path: ['checks'], message: `check ${check.checkId} coverage does not match its status` });
    }
    observed.selected += check.coverage.selected;
    observed.passed += check.coverage.passed;
    observed.skipped += check.coverage.skipped;
    if (check.status === 'failed') observed.failed += 1;
    if (check.status === 'unknown' || check.status === 'infrastructure-error' || check.status === 'cancelled' || check.status === 'no-tests') observed.unknown += 1;
  }
  if (JSON.stringify(run.coverage) !== JSON.stringify(observed)) {
    ctx.addIssue({ code: 'custom', path: ['coverage'], message: 'run coverage must equal the aggregate check coverage' });
  }
  const expectedExit = run.status === 'passed' ? 0 : run.status === 'failed' ? 1 : run.status === 'cancelled' ? 4 : run.status === 'infrastructure-error' ? 3 : 2;
  if (run.semanticExitCode !== expectedExit) ctx.addIssue({ code: 'custom', path: ['semanticExitCode'], message: 'semantic exit code does not match run status' });
  const checkStatuses = run.checks.map((check) => check.status);
  const expectedStatus = checkStatuses.includes('cancelled') ? 'cancelled'
    : checkStatuses.includes('infrastructure-error') ? 'infrastructure-error'
      : checkStatuses.includes('failed') ? 'failed'
        : checkStatuses.includes('unknown') ? 'unknown'
          : checkStatuses.includes('no-tests') || checkStatuses.length === 0 ? 'no-tests'
            : run.checks.some((check) => check.required && check.status === 'skipped') ? 'skipped'
              : checkStatuses.every((status) => status === 'not-selected') ? 'not-selected'
                : 'passed';
  if (run.status !== expectedStatus) ctx.addIssue({ code: 'custom', path: ['status'], message: `run status must aggregate to ${expectedStatus}` });
  if (run.status === 'passed' && (run.coverage.failed > 0 || run.coverage.unknown > 0 || run.coverage.selected !== run.coverage.passed + run.coverage.skipped)) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'passed requires conclusive required-check coverage' });
  }
  if (run.status === 'passed' && run.checks.some((check) => check.required && check.status !== 'passed')) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'passed requires every required check to pass' });
  }
});
export type VerificationRun = z.infer<typeof verificationRunSchema>;

/** Compatibility boundary: old validation-only projects continue on the legacy adapter path. */
export const projectValidationConfigSchema = z.object({
  validation: z.object({ changed: z.string().optional(), full: z.string().optional(), verify: z.string().optional() }).optional(),
  verification: z.unknown().optional(),
}).passthrough();
