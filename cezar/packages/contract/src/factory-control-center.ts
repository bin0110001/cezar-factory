import { z } from 'zod';

const shaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const receiptSchema = z.object({
  id: z.string(),
  channel: z.string(),
  desiredSha: shaSchema,
  actualSha: shaSchema.nullable(),
  observedSha: shaSchema.nullable(),
  state: z.enum(['pending', 'staged', 'activating', 'active', 'incompatible', 'failed', 'rolled_back']),
  requestedAt: z.string().datetime(),
  stagedAt: z.string().datetime().nullable(),
  activatedAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime().nullable(),
  compatibility: z.enum(['compatible', 'incompatible', 'unknown']),
  reasonCode: z.string().nullable(),
  message: z.string().nullable(),
  logRef: z.string().nullable(),
});

export const factoryControlCenterResponseSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    configuredChannel: z.enum(['dev', 'stable']).nullable(),
    compatibility: z.enum(['compatible', 'incompatible', 'unknown']),
    freshness: z.enum(['fresh', 'stale', 'unknown']),
    readAt: z.string().datetime(),
    findings: z.array(z.string()),
    channels: z.array(z.object({
      channel: z.enum(['dev', 'stable']),
      desiredSha: shaSchema.nullable(),
      activatedSha: shaSchema.nullable(),
      observedSha: shaSchema.nullable(),
      state: z.enum(['candidate', 'eligible', 'activating', 'healthy', 'quarantined', 'unknown']),
      updatedAt: z.string().datetime().nullable(),
      manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
      manifest: z.object({
        buildId: z.string(),
        builder: z.string(),
        workflow: z.string(),
        completedAt: z.string().datetime(),
        verificationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        verificationEvidenceRef: z.string(),
        cezarApi: z.string(),
        requiredCapabilities: z.array(z.string()),
      }).nullable(),
    })),
    history: z.array(receiptSchema),
  })),
}).strict();
export type FactoryControlCenterResponse = z.infer<typeof factoryControlCenterResponseSchema>;
