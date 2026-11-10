import { z } from 'zod';

export const CODING_RUN_SCHEMA_VERSION = 1 as const;
export const CODING_RUN_LIMITS = {
  attempts: 1_000,
  events: 100_000,
  evidence: 10_000,
  skills: 256,
  eventReferences: 256,
} as const;

const identifierSchema = z.string().min(1).max(256);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const timestampSchema = z.string().datetime();
const shaSchema = z.string().regex(/^[a-f0-9]{40,64}$/i);

/** Records an observed value without inventing sentinels for missing external metadata. */
export function codingObservationSchema<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion('availability', [
    z.object({ availability: z.literal('available'), value: valueSchema }).strict(),
    z.object({ availability: z.literal('unknown'), reason: z.string().max(512).optional() }).strict(),
    z.object({ availability: z.literal('unavailable'), reasonCode: identifierSchema, message: z.string().max(512).optional() }).strict(),
  ]);
}

export const codingRunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export const codingAttemptStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'superseded']);

const sourceIssueSchema = z.object({
  number: z.number().int().positive(),
  revision: codingObservationSchema(identifierSchema),
  url: z.string().url().optional(),
}).strict();

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url().optional(),
  headSha: shaSchema.optional(),
}).strict();

const workerIdentitySchema = z.object({
  workerId: identifierSchema,
  profileId: identifierSchema.optional(),
}).strict();

const agentIdentitySchema = z.object({
  provider: identifierSchema,
  adapterId: identifierSchema,
  adapterVersion: z.string().max(128).optional(),
}).strict();

const modelIdentitySchema = z.object({
  provider: identifierSchema,
  modelId: identifierSchema,
  subscriptionTier: identifierSchema.optional(),
}).strict();

const observationShaSchema = codingObservationSchema(shaSchema);
const observationDigestSchema = codingObservationSchema(digestSchema);
const observationVersionSchema = codingObservationSchema(identifierSchema);
const observationPullRequestSchema = codingObservationSchema(pullRequestSchema);

/** Immutable, digest-bound inputs and evidence references for one execution attempt. */
export const codingAttemptManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: identifierSchema,
  attemptId: identifierSchema,
  index: z.number().int().positive(),
  issue: z.object({ number: z.number().int().positive(), revision: codingObservationSchema(identifierSchema) }).strict(),
  baseSha: observationShaSchema,
  workerImageDigest: observationDigestSchema,
  agentCliVersion: observationVersionSchema,
  resolvedModel: observationVersionSchema,
  promptSha256: observationDigestSchema,
  skillSha256: z.array(digestSchema).max(CODING_RUN_LIMITS.skills),
  templateSha256: z.array(digestSchema).max(CODING_RUN_LIMITS.skills),
  testPolicySha256: observationDigestSchema,
  artifacts: z.array(z.lazy(() => codingEvidenceReferenceSchema)).max(CODING_RUN_LIMITS.evidence),
  commitSha: observationShaSchema,
  pullRequest: observationPullRequestSchema,
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type CodingAttemptManifest = z.infer<typeof codingAttemptManifestSchema>;

export const codingRunRecordSchema = z.object({
  schemaVersion: z.literal(CODING_RUN_SCHEMA_VERSION),
  runId: identifierSchema,
  projectId: identifierSchema,
  correlationId: identifierSchema,
  source: sourceIssueSchema,
  baseSha: codingObservationSchema(shaSchema),
  pullRequest: codingObservationSchema(pullRequestSchema),
  worker: codingObservationSchema(workerIdentitySchema),
  agent: codingObservationSchema(agentIdentitySchema),
  model: codingObservationSchema(modelIdentitySchema),
  promptSha256: codingObservationSchema(digestSchema),
  skillSha256: z.array(digestSchema).max(CODING_RUN_LIMITS.skills),
  status: codingRunStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
}).strict().superRefine((run, ctx) => {
  if (run.status === 'running' && run.finishedAt) ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'running runs cannot have finishedAt' });
  if (run.status !== 'running' && !run.finishedAt) ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'terminal runs require finishedAt' });
  if (run.finishedAt && Date.parse(run.finishedAt) < Date.parse(run.startedAt)) ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt cannot precede startedAt' });
});
export type CodingRunRecord = z.infer<typeof codingRunRecordSchema>;

export const codingAttemptRecordSchema = z.object({
  schemaVersion: z.literal(CODING_RUN_SCHEMA_VERSION),
  attemptId: identifierSchema,
  runId: identifierSchema,
  index: z.number().int().positive(),
  supersedesAttemptId: identifierSchema.optional(),
  status: codingAttemptStatusSchema,
  manifest: codingAttemptManifestSchema.optional(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
}).strict().superRefine((attempt, ctx) => {
  if (attempt.status === 'running' && attempt.finishedAt) ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'running attempts cannot have finishedAt' });
  if (attempt.status !== 'running' && !attempt.finishedAt) ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'terminal attempts require finishedAt' });
  if (attempt.finishedAt && Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt)) ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt cannot precede startedAt' });
  if (attempt.supersedesAttemptId === attempt.attemptId) ctx.addIssue({ code: 'custom', path: ['supersedesAttemptId'], message: 'an attempt cannot supersede itself' });
});
export type CodingAttemptRecord = z.infer<typeof codingAttemptRecordSchema>;

export const codingEvidenceKindSchema = z.enum(['verification', 'finding', 'artifact', 'commit', 'diff', 'review', 'other']);
export const codingEvidenceReferenceSchema = z.object({
  schemaVersion: z.literal(CODING_RUN_SCHEMA_VERSION),
  evidenceId: identifierSchema,
  kind: codingEvidenceKindSchema,
  reference: z.string().min(1).max(2_048),
  sha256: digestSchema.optional(),
  mediaType: z.string().min(1).max(128).optional(),
  bytes: z.number().int().nonnegative().optional(),
  createdAt: timestampSchema.optional(),
  /** Local content-addressed evidence expiry; the audit reference remains permanent. */
  expiresAt: timestampSchema.optional(),
  verificationId: identifierSchema.optional(),
  verificationRunId: identifierSchema.optional(),
  findingId: identifierSchema.optional(),
  occurrenceId: identifierSchema.optional(),
  episodeId: identifierSchema.optional(),
}).strict().superRefine((evidence, ctx) => {
  if (evidence.kind === 'verification' && (!evidence.verificationId || !evidence.verificationRunId)) {
    ctx.addIssue({ code: 'custom', path: ['verificationId'], message: 'verification evidence requires verification and verification-run identifiers' });
  }
  if (evidence.kind === 'finding' && !evidence.findingId) {
    ctx.addIssue({ code: 'custom', path: ['findingId'], message: 'finding evidence requires a finding identifier' });
  }
});
export type CodingEvidenceReference = z.infer<typeof codingEvidenceReferenceSchema>;

export const CODING_RUN_EVENT_TYPES = [
  'run.started', 'attempt.started', 'context.prepared', 'implementation.started',
  'implementation.completed', 'validation.completed', 'repair.started', 'repair.completed',
  'attempt.completed', 'attempt.failed', 'attempt.cancelled', 'attempt.superseded',
  'delivery.opened', 'delivery.merged', 'learning.recorded', 'run.completed', 'run.failed', 'run.cancelled',
] as const;
export const codingRunEventTypeSchema = z.enum(CODING_RUN_EVENT_TYPES);

export const codingRunEventSchema = z.object({
  schemaVersion: z.literal(CODING_RUN_SCHEMA_VERSION),
  eventId: identifierSchema,
  runId: identifierSchema,
  attemptId: identifierSchema.optional(),
  supersedesAttemptId: identifierSchema.optional(),
  manifest: codingAttemptManifestSchema.optional(),
  sequence: z.number().int().positive(),
  correlationId: identifierSchema,
  causationEventId: identifierSchema.optional(),
  type: codingRunEventTypeSchema,
  occurredAt: timestampSchema,
  evidenceIds: z.array(identifierSchema).max(CODING_RUN_LIMITS.eventReferences),
}).strict().superRefine((event, ctx) => {
  if (event.type.startsWith('attempt.') && !event.attemptId) ctx.addIssue({ code: 'custom', path: ['attemptId'], message: 'attempt events require an attempt id' });
  if (event.type !== 'attempt.started' && event.supersedesAttemptId) ctx.addIssue({ code: 'custom', path: ['supersedesAttemptId'], message: 'only attempt.started may identify a superseded attempt' });
  if (event.type !== 'attempt.started' && event.manifest) ctx.addIssue({ code: 'custom', path: ['manifest'], message: 'only attempt.started may carry an immutable manifest' });
  if (event.manifest && (event.manifest.runId !== event.runId || event.manifest.attemptId !== event.attemptId)) ctx.addIssue({ code: 'custom', path: ['manifest'], message: 'attempt manifest must identify its owning run and attempt' });
});
export type CodingRunEvent = z.infer<typeof codingRunEventSchema>;

export const codingRunSnapshotSchema = z.object({
  schemaVersion: z.literal(CODING_RUN_SCHEMA_VERSION),
  run: codingRunRecordSchema,
  attempts: z.array(codingAttemptRecordSchema).max(CODING_RUN_LIMITS.attempts),
  events: z.array(codingRunEventSchema).max(CODING_RUN_LIMITS.events),
  evidence: z.array(codingEvidenceReferenceSchema).max(CODING_RUN_LIMITS.evidence),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.run.schemaVersion !== snapshot.schemaVersion) ctx.addIssue({ code: 'custom', path: ['run', 'schemaVersion'], message: 'nested records must use the snapshot schema version' });
  const attempts = new Map<string, CodingAttemptRecord>();
  const attemptIndexes = new Set<number>();
  for (const [index, attempt] of snapshot.attempts.entries()) {
    if (attempt.runId !== snapshot.run.runId) ctx.addIssue({ code: 'custom', path: ['attempts', index, 'runId'], message: 'attempt must belong to the snapshot run' });
    if (attempts.has(attempt.attemptId)) ctx.addIssue({ code: 'custom', path: ['attempts', index, 'attemptId'], message: 'attempt ids must be unique' });
    if (attemptIndexes.has(attempt.index)) ctx.addIssue({ code: 'custom', path: ['attempts', index, 'index'], message: 'attempt indexes must be unique' });
    attempts.set(attempt.attemptId, attempt);
    attemptIndexes.add(attempt.index);
  }
  const orderedAttempts = [...snapshot.attempts].sort((a, b) => a.index - b.index);
  orderedAttempts.forEach((attempt, index) => {
    if (attempt.index !== index + 1) ctx.addIssue({ code: 'custom', path: ['attempts'], message: 'attempt indexes must be contiguous starting at 1' });
    if (attempt.supersedesAttemptId) {
      const prior = attempts.get(attempt.supersedesAttemptId);
      if (!prior || prior.index >= attempt.index) ctx.addIssue({ code: 'custom', path: ['attempts'], message: 'superseded attempt must exist earlier in the run' });
    }
    if (attempt.manifest && (attempt.manifest.runId !== attempt.runId || attempt.manifest.attemptId !== attempt.attemptId || attempt.manifest.index !== attempt.index)) {
      ctx.addIssue({ code: 'custom', path: ['attempts', index, 'manifest'], message: 'attempt manifest identity must match its attempt record' });
    }
  });
  const evidenceIds = new Set<string>();
  snapshot.evidence.forEach((item, index) => {
    if (evidenceIds.has(item.evidenceId)) ctx.addIssue({ code: 'custom', path: ['evidence', index, 'evidenceId'], message: 'evidence ids must be unique' });
    evidenceIds.add(item.evidenceId);
  });
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  let previousSequence = 0;
  const events = new Map(snapshot.events.map((event) => [event.eventId, event]));
  snapshot.events.forEach((event, index) => {
    if (event.runId !== snapshot.run.runId) ctx.addIssue({ code: 'custom', path: ['events', index, 'runId'], message: 'event must belong to the snapshot run' });
    if (event.correlationId !== snapshot.run.correlationId) ctx.addIssue({ code: 'custom', path: ['events', index, 'correlationId'], message: 'event correlation id must match the run' });
    if (event.attemptId && !attempts.has(event.attemptId)) ctx.addIssue({ code: 'custom', path: ['events', index, 'attemptId'], message: 'event must reference an attempt in the snapshot' });
    if (eventIds.has(event.eventId)) ctx.addIssue({ code: 'custom', path: ['events', index, 'eventId'], message: 'event ids must be unique' });
    if (sequences.has(event.sequence) || event.sequence <= previousSequence) ctx.addIssue({ code: 'custom', path: ['events', index, 'sequence'], message: 'events must have unique, increasing sequence numbers' });
    if (event.sequence !== index + 1) ctx.addIssue({ code: 'custom', path: ['events', index, 'sequence'], message: 'event sequence must be contiguous starting at 1' });
    if (event.causationEventId) {
      const cause = events.get(event.causationEventId);
      if (!cause || cause.sequence >= event.sequence) ctx.addIssue({ code: 'custom', path: ['events', index, 'causationEventId'], message: 'causation event must exist earlier in the run' });
    }
    for (const evidenceId of event.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) ctx.addIssue({ code: 'custom', path: ['events', index, 'evidenceIds'], message: 'event evidence reference must exist in the snapshot' });
    }
    previousSequence = event.sequence;
    eventIds.add(event.eventId);
  });
});
export type CodingRunSnapshot = z.infer<typeof codingRunSnapshotSchema>;

/** Permission-scoped, bounded read model used by the issue run explorer. */
export const codingRunExplorerEntrySchema = z.object({
  runId: identifierSchema,
  issueNumber: z.number().int().positive(),
  status: z.enum(['running', 'waiting', 'blocked', 'unknown', 'untested', 'flaky', 'passed', 'failed', 'cancelled']),
  integrity: z.enum(['valid', 'incomplete', 'corrupt', 'unsupported-version']),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  worker: codingObservationSchema(workerIdentitySchema),
  agent: codingObservationSchema(agentIdentitySchema),
  model: codingObservationSchema(modelIdentitySchema),
  pullRequest: codingObservationSchema(pullRequestSchema),
  commits: z.array(shaSchema).max(100),
  validationCount: z.number().int().nonnegative(),
  latestValidationAt: timestampSchema.optional(),
  attemptCount: z.number().int().nonnegative(),
  attempts: z.array(z.object({
    attemptId: identifierSchema, index: z.number().int().positive(),
    status: codingAttemptStatusSchema, startedAt: timestampSchema, finishedAt: timestampSchema.optional(),
    supersedesAttemptId: identifierSchema.optional(),
  }).strict()).max(100),
  eventCount: z.number().int().nonnegative(),
  timeline: z.array(z.object({
    eventId: identifierSchema, type: codingRunEventTypeSchema, occurredAt: timestampSchema,
    attemptId: identifierSchema.optional(), evidenceCount: z.number().int().nonnegative(),
  }).strict()).max(100),
  timelineTruncated: z.boolean(),
  evidence: z.array(z.object({
    evidenceId: identifierSchema, kind: codingEvidenceKindSchema,
    sha256: digestSchema.optional(), createdAt: timestampSchema.optional(), expiresAt: timestampSchema.optional(),
    availability: z.enum(['available', 'expired', 'unknown']),
    downloadUrl: z.string().min(1).max(2048).optional(),
  }).strict()).max(100),
  evidenceCount: z.number().int().nonnegative(),
  evidenceComplete: z.boolean(),
  trace: z.discriminatedUnion('availability', [
    z.object({ availability: z.literal('available'), url: z.string().url(), traceId: z.string().regex(/^[a-f0-9]{32}$/i) }).strict(),
    z.object({ availability: z.literal('unavailable'), reason: z.string().max(256) }).strict(),
  ]),
}).strict();
export type CodingRunExplorerEntry = z.infer<typeof codingRunExplorerEntrySchema>;

export const codingRunExplorerResponseSchema = z.object({
  issueNumber: z.number().int().positive(),
  runs: z.array(codingRunExplorerEntrySchema).max(50),
  nextCursor: z.string().max(2048).optional(),
  complete: z.boolean(),
  unavailableReason: z.string().max(256).optional(),
}).strict();
export type CodingRunExplorerResponse = z.infer<typeof codingRunExplorerResponseSchema>;
export const codingRunExplorerParamsSchema = z.object({ issueNumber: z.string().regex(/^[1-9]\d{0,14}$/), runId: identifierSchema.optional(), sha256: digestSchema.optional() });
export const codingRunExplorerArtifactParamsSchema = z.object({ issueNumber: z.string().regex(/^[1-9]\d{0,14}$/), runId: identifierSchema, sha256: digestSchema });
export const codingRunExplorerQuerySchema = z.object({ cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });

export type CodingRunContractParse =
  | { status: 'valid'; data: CodingRunSnapshot }
  | { status: 'invalid'; issues: z.ZodIssue[] }
  | { status: 'unknown-schema'; schemaVersion: string | number };

/** Parse v1 while making an unsupported future version distinct from malformed v1 data. */
export function parseCodingRunSnapshot(input: unknown): CodingRunContractParse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 'invalid', issues: [] };
  const version = (input as Record<string, unknown>).schemaVersion;
  if ((typeof version === 'string' || typeof version === 'number') && version !== CODING_RUN_SCHEMA_VERSION) {
    return { status: 'unknown-schema', schemaVersion: version };
  }
  const parsed = codingRunSnapshotSchema.safeParse(input);
  return parsed.success ? { status: 'valid', data: parsed.data } : { status: 'invalid', issues: parsed.error.issues };
}
