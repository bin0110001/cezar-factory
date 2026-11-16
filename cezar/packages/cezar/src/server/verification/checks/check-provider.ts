import { z } from 'zod';

/**
 * Check-provider contract (#616): a provider-neutral description of quality,
 * security and supply-chain checks. Scanner brands never appear here; a
 * provider is data (name/version/digest). An unavailable feed or failed
 * execution can never yield `pass`.
 */

export const CHECK_PROVIDER_CONTRACT_VERSION = 1;

export const CHECK_CATEGORIES = [
  'format', 'lint', 'type', 'test', 'sast', 'sca', 'secrets', 'iac', 'container', 'license', 'sbom', 'complexity', 'custom', 'ai-audit',
] as const;
export const checkCategorySchema = z.enum(CHECK_CATEGORIES);
export type CheckCategory = z.infer<typeof checkCategorySchema>;

export const SCAN_SCOPES = ['changed-files', 'full-repo', 'baseline-diff', 'binary-image', 'git-history'] as const;
export const scanScopeSchema = z.enum(SCAN_SCOPES);

export const TRIGGER_SOURCES = ['pr-dev', 'release-candidate', 'periodic-independent', 'manual', 'risk-event'] as const;
export const triggerSourceSchema = z.enum(TRIGGER_SOURCES);

export const CHECK_STATUSES = ['pass', 'fail', 'warn', 'unknown', 'error'] as const;
export const checkStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const providerIdentitySchema = z.object({
  name: idSchema,
  version: z.string().min(1).max(64),
  digest: digestSchema,
}).strict();

export const checkPolicySchema = z.object({
  mandatory: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(6 * 3_600_000),
  /** What a timeout or crash yields. `pass` is not expressible. */
  onFailure: z.enum(['fail', 'unknown', 'error']).default('error'),
  /** What an unavailable or stale advisory feed yields. `pass` is not expressible. */
  onFeedUnavailable: z.enum(['fail', 'unknown', 'error']).default('unknown'),
  maxAgeHours: z.number().positive().max(24 * 365).optional(),
  cache: z.object({ enabled: z.boolean().default(false), ttlHours: z.number().positive().max(24 * 30).optional() }).strict().default(() => ({ enabled: false })),
}).strict();

export const checkScheduleSchema = z.object({
  /** Cron expression evaluated in `timezone`; scheduling is independent of any release candidate. */
  cron: z.string().min(1).max(128),
  timezone: z.string().min(1).max(64),
}).strict();

export const checkDefinitionSchema = z.object({
  id: idSchema,
  category: checkCategorySchema,
  provider: providerIdentitySchema,
  /** Languages/ecosystems/file kinds the check applies to; empty means all. */
  applicability: z.array(z.string().min(1).max(64)).max(64).default([]),
  scopes: z.array(scanScopeSchema).min(1),
  triggers: z.array(triggerSourceSchema).min(1),
  schedule: checkScheduleSchema.optional(),
  inputs: z.array(z.string().min(1).max(256)).max(64).default([]),
  artifacts: z.array(z.string().min(1).max(256)).max(64).default([]),
  hints: z.object({
    cpus: z.number().positive().max(64).optional(),
    memoryMib: z.number().int().positive().max(262_144).optional(),
    expectedSeconds: z.number().int().positive().max(6 * 3600).optional(),
    costUnits: z.number().min(0).max(1_000_000).optional(),
  }).strict().default({}),
  policy: checkPolicySchema,
}).strict().superRefine((def, ctx) => {
  if (def.triggers.includes('periodic-independent') && !def.schedule) {
    ctx.addIssue({ code: 'custom', path: ['schedule'], message: 'a periodic-independent check needs a schedule' });
  }
});
export type CheckDefinition = z.infer<typeof checkDefinitionSchema>;

export const checkResultSchema = z.object({
  checkId: idSchema,
  provider: providerIdentitySchema,
  status: checkStatusSchema,
  execution: z.enum(['completed', 'failed', 'timeout', 'not-run']),
  feed: z.enum(['fresh', 'stale', 'unavailable', 'not-applicable']),
  /** Findings count is separate from status: zero findings is only meaningful if the scan completed. */
  findingCount: z.number().int().min(0),
  blockingFindingCount: z.number().int().min(0),
  reason: z.string().max(500).optional(),
}).strict().superRefine((r, ctx) => {
  const add = (message: string) => ctx.addIssue({ code: 'custom', path: ['status'], message });
  if (r.blockingFindingCount > r.findingCount) add('blockingFindingCount exceeds findingCount');
  if (r.status === 'pass') {
    if (r.execution !== 'completed') add('pass requires a completed execution');
    if (r.feed === 'stale' || r.feed === 'unavailable') add('pass is not allowed with a stale or unavailable feed');
    if (r.blockingFindingCount > 0) add('pass is not allowed with blocking findings');
  }
  if (r.execution !== 'completed' && (r.status === 'warn')) add('warn requires a completed execution');
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export interface CheckOutcomeInput {
  execution: CheckResult['execution'];
  feed: CheckResult['feed'];
  findingCount: number;
  blockingFindingCount: number;
  policy: z.infer<typeof checkPolicySchema>;
}

/** Derive the only permitted status; used so providers cannot assert `pass` themselves. */
export function deriveCheckStatus(i: CheckOutcomeInput): CheckStatus {
  if (i.execution !== 'completed') return i.policy.onFailure;
  if (i.feed === 'stale' || i.feed === 'unavailable') return i.policy.onFeedUnavailable;
  if (i.blockingFindingCount > 0) return 'fail';
  return i.findingCount > 0 ? 'warn' : 'pass';
}

export const checkProviderConfigSchema = z.object({
  version: z.literal(CHECK_PROVIDER_CONTRACT_VERSION),
  checks: z.array(checkDefinitionSchema).max(256),
}).strict().superRefine((cfg, ctx) => {
  const seen = new Set<string>();
  cfg.checks.forEach((c, i) => {
    if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['checks', i, 'id'], message: `duplicate check id ${c.id}` });
    seen.add(c.id);
  });
});
export type CheckProviderConfig = z.infer<typeof checkProviderConfigSchema>;

export function checkProviderJsonSchema(): unknown {
  return z.toJSONSchema(checkProviderConfigSchema);
}
