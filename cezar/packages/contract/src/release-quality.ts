import { z } from 'zod';

/**
 * Quality actions for the Control Center (#603): a review-only waiver request with audit, and a dry run of the check policy against the last
 * candidate. The service never grants a waiver or changes a candidate: it validates, records an audited request for the host engine, and
 * computes what a policy would do. Nothing here carries a raw secret match.
 */

const iso = z.string().datetime();
export const QUALITY_STAGES = ['pr-dev', 'candidate', 'stable', 'periodic', 'manual'] as const;
export const qualityStageSchema = z.enum(QUALITY_STAGES);

export const waiverRequestSchema = z.object({
  projectId: z.string().min(1).max(256),
  candidateId: z.string().min(1).max(128).optional(),
  /** A waiver names what it covers: a finding or an advisory. A blanket waiver is not expressible. */
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  advisoryId: z.string().min(1).max(128).optional(),
  stages: z.array(qualityStageSchema).min(1).max(5),
  pathGlob: z.string().min(1).max(512).optional(),
  reason: z.string().trim().min(10).max(300),
  /** Waivers expire; the policy sets the maximum. */
  expiresInDays: z.number().int().min(1).max(365),
}).strict().refine((w) => Boolean(w.fingerprint || w.advisoryId), { message: 'a waiver must name a fingerprint or an advisory id (no blanket waivers)', path: ['fingerprint'] });
export type WaiverRequest = z.infer<typeof waiverRequestSchema>;

export const waiverResponseSchema = z.object({
  accepted: z.literal(true),
  requestId: z.string().min(1).max(64),
  projectId: z.string(),
  expiresAt: iso,
  maxDays: z.number().int().min(1),
  /** Queued for the host engine, which records the waiver; this view only requests and audits it. */
  status: z.literal('queued'),
  message: z.string().max(300),
}).strict();
export type WaiverResponse = z.infer<typeof waiverResponseSchema>;

export const qualityDryRunRequestSchema = z.object({
  projectId: z.string().min(1).max(256),
  /** A quality-gates/v1 document (docs/quality-gates.md), usually the one being edited. */
  policy: z.record(z.string().max(64), z.unknown()),
  repoType: z.string().min(1).max(64).optional(),
}).strict();
export type QualityDryRunRequest = z.infer<typeof qualityDryRunRequestSchema>;

export const qualityDryRunResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string().max(400)).max(50),
  /** The candidate the policy was applied to (the active one, else the most recent), or null when there is none. */
  candidateId: z.string().nullable(),
  stages: z.array(z.object({
    stage: qualityStageSchema,
    wouldBlock: z.boolean(),
    checks: z.array(z.object({
      category: z.string(),
      status: z.enum(['pass', 'fail', 'warn', 'unknown', 'error', 'not-applicable']),
      level: z.enum(['required', 'optional', 'advisory', 'off']),
      onUnavailable: z.enum(['fail-closed', 'fail-open']),
      blocks: z.boolean(),
      /** Why the result is what it is, e.g. a required check with no result counts as unknown. */
      note: z.string().max(200),
    }).strict()),
  }).strict()),
  estimate: z.object({ computeHours: z.number().min(0).nullable(), basis: z.string().max(200) }).strict(),
  warnings: z.array(z.string().max(300)).max(20),
}).strict();
export type QualityDryRunResponse = z.infer<typeof qualityDryRunResponseSchema>;
