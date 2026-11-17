import { z } from 'zod';

/**
 * Release pipeline policy editor API (#632). The document shape is `release-pipeline/v1` (docs/release-pipeline-config.md); the
 * service validates a project's override, previews the effective configuration and the next runs, and saves it with an audit entry
 * (who, when, before and after hashes). Values are redacted on the way out; the policy holds no secrets by design.
 */

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const iso = z.string().datetime();

/** A project's override of the defaults, as the editor sends it. Deep validation is the engine's schema, reported as `errors`. */
export const pipelinePolicyOverrideSchema = z.record(z.string().max(64), z.unknown());

export const pipelinePolicyPreviewRequestSchema = z.object({
  projectId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/),
  policy: pipelinePolicyOverrideSchema,
}).strict();
export type PipelinePolicyPreviewRequest = z.infer<typeof pipelinePolicyPreviewRequestSchema>;

export const pipelinePolicyPreviewResponseSchema = z.object({
  valid: z.boolean(),
  /** Each error starts with its path, e.g. `projects.shop.promotion.bogus: unknown field`. */
  errors: z.array(z.string().max(400)).max(100),
  effective: z.record(z.string(), z.unknown()).nullable(),
  effectiveHash: hash.nullable(),
  /** Hash of the effective configuration that is saved today for this project, if any (what a candidate would be bound to now). */
  currentHash: hash.nullable(),
  /** The next scheduled runs (UTC), DST-correct; empty when there is no calendar schedule. */
  nextRuns: z.array(iso).max(10),
}).strict();
export type PipelinePolicyPreviewResponse = z.infer<typeof pipelinePolicyPreviewResponseSchema>;

export const pipelinePolicySaveRequestSchema = pipelinePolicyPreviewRequestSchema.extend({
  reason: z.string().trim().min(3).max(300),
  /** The effective hash the editor loaded; a different current hash means someone else changed it, so the save is refused. */
  expectedCurrentHash: hash.nullable().optional(),
}).strict();
export type PipelinePolicySaveRequest = z.infer<typeof pipelinePolicySaveRequestSchema>;

export const pipelinePolicySaveResponseSchema = z.object({
  saved: z.literal(true),
  projectId: z.string(),
  beforeHash: hash.nullable(),
  afterHash: hash,
  auditId: z.string().min(1).max(64),
  /** Existing candidates keep the configuration they were bound to; the change applies to future candidates. */
  appliesTo: z.literal('future-candidates'),
}).strict();
export type PipelinePolicySaveResponse = z.infer<typeof pipelinePolicySaveResponseSchema>;

export const pipelinePolicyDocumentResponseSchema = z.object({
  schemaVersion: z.literal(1),
  /** False until an operator saves a policy; the engine then runs its built-in defaults. */
  available: z.boolean(),
  projects: z.record(z.string(), z.object({ policy: pipelinePolicyOverrideSchema, effectiveHash: hash.nullable() }).strict()),
  audit: z.array(z.object({
    id: z.string(), at: iso, actor: z.string(), projectId: z.string(), beforeHash: hash.nullable(), afterHash: hash, reason: z.string().max(300),
  }).strict()).max(50),
}).strict();
export type PipelinePolicyDocumentResponse = z.infer<typeof pipelinePolicyDocumentResponseSchema>;
