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
  repairObligations: z.array(z.object({ id: z.string().max(128), state: z.enum(['pending', 'applied', 'equivalent', 'conflict', 'waived']), blocksStable: z.boolean(), openedAt: iso.optional() }).strict()).max(200),
  receipts: z.array(z.object({ id: z.string().max(128), kind: z.enum(['promotion', 'activation', 'rollback']), at: iso, ok: z.boolean() }).strict()).max(200),
  pending: z.object({ count: z.number().int().min(0), coalescedReason: z.string().max(300).nullable(), triggers: z.array(z.string().max(32)).max(10) }).strict(),
  nextScheduledAttempt: iso.nullable(),
  links: z.object({ pullRequests: z.array(z.number().int().positive()).max(50), issues: z.array(z.number().int().positive()).max(50) }).strict(),
  warnings: z.array(z.object({ kind: z.enum(['adapter', 'branch', 'worker', 'integrity', 'stale-lease']), message: z.string().max(300) }).strict()).max(50),
  checkMatrix: z.array(checkMatrixRowSchema).max(64),
  /** When the candidate reached each point. Optional: the metrics use only what the engine recorded. */
  timing: z.object({ queuedAt: iso.nullable(), admittedAt: iso.nullable(), readyAt: iso.nullable(), terminalAt: iso.nullable() }).strict().optional(),
  /** Compute spent validating, in seconds, when the engine measured it. */
  cost: z.object({ computeSeconds: z.number().min(0) }).strict().optional(),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;

export const scheduledCheckRunSchema = z.object({ checkId: z.string().max(128), ranAt: iso, status: z.enum(['pass', 'fail', 'warn', 'unknown', 'error', 'not-applicable']) }).strict();
export const aiAuditRunSchema = z.object({ at: iso, outcome: z.enum(['ran', 'skipped']), reason: z.string().max(80), costUsd: z.number().min(0), tokens: z.number().int().min(0) }).strict();

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
    /** Independent periodic check runs (scans, license audits), separate from any candidate. */
    scheduledChecks: z.array(scheduledCheckRunSchema).max(200).default([]),
    /** Opt-in AI audit runs and why a run happened or was skipped; cost is what it consumed. */
    aiAudit: z.array(aiAuditRunSchema).max(200).default([]),
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

// ---- history and metrics (#635) ----------------------------------------------------------------------------------------------
export const releaseHistoryEntrySchema = z.object({
  id: z.string().max(64),
  at: iso,
  kind: z.enum(['operator-action', 'policy-change', 'waiver']),
  projectId: z.string().max(256),
  actor: z.string().max(128),
  summary: z.string().max(300),
  candidateId: z.string().max(128).nullable(),
  beforeHash: hash.nullable(),
  afterHash: hash.nullable(),
}).strict();
export const releaseHistoryResponseSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: iso,
  /** Entries older than a project's retention window are omitted; this is that window per project. */
  retentionDays: z.record(z.string(), z.number().int().min(1)),
  entries: z.array(releaseHistoryEntrySchema).max(500),
  candidates: z.array(z.object({ projectId: z.string(), id: z.string(), state: candidateStateSchema, revision: z.number().int().min(0), createdAt: iso, updatedAt: iso }).strict()).max(500),
}).strict();
export type ReleaseHistoryResponse = z.infer<typeof releaseHistoryResponseSchema>;

const num = z.number().nullable();
export const projectMetricsSchema = z.object({
  projectId: z.string(),
  /** Mean and worst wait from queued to admitted, in minutes, over candidates that recorded both. */
  queueWaitMinutes: z.object({ mean: num, max: num, samples: z.number().int().min(0) }).strict(),
  /** Total and mean compute hours over candidates that recorded a cost. */
  suiteCostHours: z.object({ total: num, mean: num, samples: z.number().int().min(0) }).strict(),
  /** Candidates that needed a repair revision (revision above 1), out of the candidates counted. */
  regressions: z.object({ candidatesWithRepair: z.number().int().min(0), candidates: z.number().int().min(0) }).strict(),
  /** Age in hours of the oldest unresolved forward-port obligation that recorded when it opened. */
  forwardPortLagHours: z.object({ oldest: num, unresolved: z.number().int().min(0) }).strict(),
  /** Hours since the most recent successful promotion receipt. */
  stableAgeHours: num,
  scheduledChecks: z.object({ runs: z.number().int().min(0), failing: z.number().int().min(0), lastRanAt: iso.nullable() }).strict(),
  aiAudit: z.object({ ran: z.number().int().min(0), skipped: z.number().int().min(0), costUsd: z.number().min(0), tokens: z.number().int().min(0) }).strict(),
}).strict();
export type ProjectMetrics = z.infer<typeof projectMetricsSchema>;
export const releaseMetricsResponseSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: iso,
  available: z.boolean(),
  projects: z.array(projectMetricsSchema),
}).strict();
export type ReleaseMetricsResponse = z.infer<typeof releaseMetricsResponseSchema>;
