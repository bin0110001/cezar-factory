import { z } from 'zod';

/**
 * Read-only release-candidate model for the Control Center (#631). One active (nonterminal) candidate per project; everything
 * here is redacted by construction (no tokens, no raw config values, no secret matches). The host writes the snapshot; the service
 * validates and serves it. Spec: epic #588.
 */

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const iso = z.string().datetime();
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const CANDIDATE_STATES = ['requested', 'admitted', 'snapshotting', 'validating', 'repair-required', 'revalidating', 'ready', 'awaiting-approval', 'promoting', 'activating', 'promoted', 'abandoned', 'failed', 'canceled'] as const;
export const TERMINAL_CANDIDATE_STATES = ['promoted', 'abandoned', 'failed', 'canceled'] as const;
export const candidateStateSchema = z.enum(CANDIDATE_STATES);

export const checkMatrixRowSchema = z.object({
  category: z.string().min(1).max(64),
  /** `pass|fail|warn|unknown|error|not-applicable`, from the check-provider contract. */
  status: z.enum(['pass', 'fail', 'warn', 'unknown', 'error', 'not-applicable']),
  blocking: z.boolean(),
  /** Findings that are new versus the trusted baseline, and known (baselined) ones. */
  newFindings: z.number().int().min(0),
  knownFindings: z.number().int().min(0),
  provider: z.object({ name: z.string().max(64), version: z.string().max(64) }).nullable(),
  /** Advisory feed freshness and scan scope, never raw evidence. */
  feed: z.enum(['fresh', 'stale', 'unavailable', 'not-applicable']),
  scope: z.string().max(64).nullable(),
  sbomDigest: hash.nullable(),
  activeWaivers: z.number().int().min(0),
}).strict();
export type CheckMatrixRow = z.infer<typeof checkMatrixRowSchema>;

export const candidateSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1).max(256),
  state: candidateStateSchema,
  revision: z.number().int().min(0),
  devSha: sha,
  baseStableSha: sha,
  candidateSha: sha.nullable(),
  configHash: hash,
  createdAt: iso,
  updatedAt: iso,
  lease: z.object({ owner: z.string().max(128).nullable(), expiresAt: iso.nullable(), stale: z.boolean() }).strict(),
  tests: z.object({
    status: z.enum(['pending', 'running', 'passed', 'failed', 'unknown']),
    shards: z.object({ total: z.number().int().min(0), passed: z.number().int().min(0), failed: z.number().int().min(0) }).strict(),
    assetVersion: z.string().max(128).nullable(),
  }).strict(),
  devDrift: z.object({ commitsAhead: z.number().int().min(0), newestDevSha: sha.nullable() }).strict(),
  blockers: z.array(z.object({ code: z.string().min(1).max(64), message: z.string().max(300) }).strict()).max(50),
  repairObligations: z.array(z.object({ id: z.string().max(128), state: z.enum(['pending', 'applied', 'equivalent', 'conflict', 'waived']), blocksStable: z.boolean() }).strict()).max(200),
  receipts: z.array(z.object({ id: z.string().max(128), kind: z.enum(['promotion', 'activation', 'rollback']), at: iso, ok: z.boolean() }).strict()).max(200),
  pending: z.object({ count: z.number().int().min(0), coalescedReason: z.string().max(300).nullable(), triggers: z.array(z.string().max(32)).max(10) }).strict(),
  nextScheduledAttempt: iso.nullable(),
  links: z.object({ pullRequests: z.array(z.number().int().positive()).max(50), issues: z.array(z.number().int().positive()).max(50) }).strict(),
  warnings: z.array(z.object({ kind: z.enum(['adapter', 'branch', 'worker', 'integrity', 'stale-lease']), message: z.string().max(300) }).strict()).max(50),
  checkMatrix: z.array(checkMatrixRowSchema).max(64),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;

export const releaseCandidatesResponseSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: iso,
  /** False when no host snapshot exists yet; the rest is then empty rather than an error. */
  available: z.boolean(),
  /** The snapshot's own age, so the UI can say the data is stale. */
  snapshotAt: iso.nullable(),
  projects: z.array(z.object({
    projectId: z.string().min(1).max(256),
    /** At most one nonterminal candidate; more than one is an integrity violation reported in `warnings`, not hidden. */
    active: candidateSchema.nullable(),
    history: z.array(candidateSchema).max(50),
    warnings: z.array(z.string().max(300)).max(20),
  }).strict()),
}).strict();
export type ReleaseCandidatesResponse = z.infer<typeof releaseCandidatesResponseSchema>;

// ---- operator actions (#634) --------------------------------------------------------------------------------------------------
// The service never mutates candidate state. It validates an action against the published snapshot (permission, typed
// confirmation, the one-active-candidate rule) and appends an audited request for the host release engine to apply through its
// lifecycle state machine.

export const CANDIDATE_ACTIONS = ['create', 'pause', 'resume', 'cancel', 'abandon', 'retry'] as const;
export const DESTRUCTIVE_CANDIDATE_ACTIONS = ['cancel', 'abandon'] as const;
export const candidateActionSchema = z.enum(CANDIDATE_ACTIONS);
export type CandidateAction = z.infer<typeof candidateActionSchema>;

export const candidateActionRequestSchema = z.object({
  action: candidateActionSchema,
  projectId: z.string().min(1).max(256),
  /** Required for every action except `create`. */
  candidateId: z.string().min(1).max(128).optional(),
  reason: z.string().trim().min(3).max(300),
  /** For cancel and abandon: the operator types the candidate id to confirm. */
  confirm: z.string().max(128).optional(),
}).strict();
export type CandidateActionRequest = z.infer<typeof candidateActionRequestSchema>;

export const candidateActionResponseSchema = z.object({
  accepted: z.literal(true),
  requestId: z.string().min(1).max(64),
  action: candidateActionSchema,
  projectId: z.string().min(1).max(256),
  candidateId: z.string().max(128).nullable(),
  /** The request is queued for the host engine; the candidate changes state only when the engine applies it. */
  status: z.literal('queued'),
  message: z.string().max(300),
}).strict();
export type CandidateActionResponse = z.infer<typeof candidateActionResponseSchema>;
