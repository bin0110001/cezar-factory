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

/** Operator candidate actions (#634). Scopes are deny-by-default and one per action. */
export const candidateActionSchema = z.enum(['create', 'pause', 'resume', 'cancel', 'abandon', 'retry']);
export type CandidateAction = z.infer<typeof candidateActionSchema>;
export const candidateActionScopes = {
  create: 'candidate:create', pause: 'candidate:pause', resume: 'candidate:resume',
  cancel: 'candidate:cancel', abandon: 'candidate:abandon', retry: 'candidate:retry',
} as const satisfies Record<CandidateAction, string>;
/** Actions that need the typed confirmation phrase `<action> <candidateId>`. */
export const destructiveCandidateActions = ['cancel', 'abandon'] as const satisfies readonly CandidateAction[];

export const candidateActionRequestSchema = z.object({
  projectId: z.string().min(1),
  action: candidateActionSchema,
  /** Required for every action except `create`. */
  candidateId: z.string().min(1).optional(),
  /** Required for create: the commit the candidate is built from. */
  sourceSha: shaSchema.optional(),
  /** Typed confirmation, exactly `<action> <candidateId>`; required for cancel and abandon. */
  confirmation: z.string().optional(),
}).strict();
export type CandidateActionRequest = z.infer<typeof candidateActionRequestSchema>;

export const candidateActionOutcomeSchema = z.enum(['accepted', 'denied', 'rejected', 'confirmation_required', 'failed']);
export const candidateActionResponseSchema = z.object({
  schemaVersion: z.literal(1),
  outcome: candidateActionOutcomeSchema,
  message: z.string(),
  candidateId: z.string().nullable(),
  state: z.string().nullable(),
}).strict();
export type CandidateActionResponse = z.infer<typeof candidateActionResponseSchema>;

export const candidateAuditEntrySchema = z.object({
  at: z.string().datetime(),
  actor: z.string(),
  projectId: z.string(),
  candidateId: z.string().nullable(),
  action: candidateActionSchema,
  outcome: candidateActionOutcomeSchema,
}).strict();
export type CandidateAuditEntry = z.infer<typeof candidateAuditEntrySchema>;
