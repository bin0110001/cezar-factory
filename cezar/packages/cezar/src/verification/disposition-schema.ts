import { z } from 'zod';

/** Per-run decision classes. `known` is never `waived`: a waiver is a separate record. */
export const DISPOSITION_CLASSES = [
  'new', 'known', 'worsened', 'resolved', 'reopened', 'untested', 'unknown', 'infra-failure',
] as const;
export const dispositionClassSchema = z.enum(DISPOSITION_CLASSES);
export type DispositionClass = z.infer<typeof dispositionClassSchema>;

const idSchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime();

/**
 * One decision about one finding (or, with a null fingerprint, about the whole run)
 * for one verification run. Immutable once written; the observation it is based on
 * is an Occurrence and is never changed by a disposition.
 */
export const dispositionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  runId: idSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  checkId: z.string().max(256).nullable(),
  disposition: dispositionClassSchema,
  /** `blocking` dispositions can never be read as a pass. */
  decision: z.enum(['blocking', 'non-blocking']),
  reason: z.string().min(1).max(2_000),
  evidenceRefs: z.array(idSchema).max(100),
  policyVersion: z.number().int().positive(),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable(),
  environmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.string().min(1).max(256),
  at: timestampSchema,
  /** Set when an active, valid waiver covers this disposition. Does not change `disposition`. */
  waiverId: idSchema.nullable(),
}).strict();
export type DispositionRecord = z.infer<typeof dispositionSchema>;

/** A scoped, expiring waiver granted by an authority other than the run author. */
export const waiverSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** Branches the waiver applies to; never empty so a waiver cannot be global. */
  branches: z.array(z.string().min(1).max(256)).min(1).max(50),
  reason: z.string().min(1).max(2_000),
  grantedBy: z.string().min(1).max(256),
  grantedAt: timestampSchema,
  expiresAt: timestampSchema,
  policyVersion: z.number().int().positive(),
}).strict().refine((waiver) => Date.parse(waiver.expiresAt) > Date.parse(waiver.grantedAt), 'waiver must expire after it is granted');
export type WaiverRecord = z.infer<typeof waiverSchema>;
