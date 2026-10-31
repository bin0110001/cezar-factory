import { z } from 'zod';

/**
 * Dependency Intelligence v1 wire and persistence contracts.
 *
 * Edge direction is always prerequisite -> dependent: `from BLOCKS to` means `from` must finish
 * before `to` can start. Only a verified BLOCKS edge is eligible to affect scheduler admission.
 */
export const DEPENDENCY_GRAPH_SCHEMA_VERSION = 1 as const;
export const DEPENDENCY_GRAPH_LIMITS = {
  titleChars: 500,
  questionChars: 2_000,
  rationaleChars: 8_000,
  evidenceItems: 100,
  evidenceExcerptChars: 2_000,
  decisionOptions: 32,
  affectedNodes: 10_000,
} as const;

export const dependencyNodeKindSchema = z.enum(['issue', 'epic', 'decision', 'milestone', 'external-blocker']);
export type DependencyNodeKind = z.infer<typeof dependencyNodeKindSchema>;

export const dependencyNodeIdSchema = z.string().min(1).max(768).regex(
  /^(issue|epic|decision|milestone|external-blocker):[A-Za-z0-9.-]+\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+:[A-Za-z0-9._~-]+$/,
  'must be a repository-qualified dependency node id',
);
export type DependencyNodeId = z.infer<typeof dependencyNodeIdSchema>;

export const githubRepositoryKeySchema = z.string().regex(
  /^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/,
  'must be owner/repository or host/owner/repository',
);
export type GithubRepositoryKey = z.infer<typeof githubRepositoryKeySchema>;

function repositoryPath(repository: GithubRepositoryKey): string {
  return repository.split('/').length === 2 ? `github.com/${repository}` : repository;
}

export function dependencyNodeId(kind: DependencyNodeKind, repository: GithubRepositoryKey, key: string | number): DependencyNodeId {
  return dependencyNodeIdSchema.parse(`${kind}:${repositoryPath(repository)}:${key}`);
}

export function isDependencyNodeInRepository(id: DependencyNodeId, repository: GithubRepositoryKey): boolean {
  const prefix = repositoryPath(repository);
  return dependencyNodeKindSchema.options.some((kind) => id.startsWith(`${kind}:${prefix}:`));
}

const provenanceSchema = z.object({
  origin: z.enum(['github-native', 'explicit-metadata', 'human', 'model', 'system']),
  authority: z.enum(['verified', 'proposed', 'unverified']),
  confidence: z.number().finite().min(0).max(1),
  recordedAt: z.iso.datetime({ offset: true }),
  sourceRevision: z.string().min(1).max(256).optional(),
  sourceUrl: z.url({ protocol: /^https$/ }).optional(),
  evidence: z.array(z.object({
    url: z.url({ protocol: /^https$/ }),
    label: z.string().trim().min(1).max(256),
  }).strict()).max(DEPENDENCY_GRAPH_LIMITS.evidenceItems),
}).strict();
export type DependencyProvenance = z.infer<typeof provenanceSchema>;

const issueNodeSchema = z.object({
  kind: z.enum(['issue', 'epic']),
  id: dependencyNodeIdSchema,
  repository: githubRepositoryKeySchema,
  number: z.number().int().positive(),
  title: z.string().max(DEPENDENCY_GRAPH_LIMITS.titleChars),
  state: z.enum(['open', 'closed']),
  status: z.string().trim().min(1).max(128).optional(),
  labels: z.array(z.string().trim().min(1).max(128)).max(256),
  bodyText: z.string().max(8_000).optional(),
  url: z.url({ protocol: /^https$/ }),
  revision: z.string().min(1).max(256),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

const decisionStateSchema = z.enum(['proposed', 'approved', 'resolved', 'deferred', 'reopened', 'superseded', 'rejected']);
export type DecisionState = z.infer<typeof decisionStateSchema>;

export const decisionAuthorizationSchema = z.enum([
  'read-only',
  'agent-proposal',
  'policy-approved-low-risk',
  'human-approval',
]);
export type DecisionAuthorization = z.infer<typeof decisionAuthorizationSchema>;

export const decisionEvidenceSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  label: z.string().trim().min(1).max(256),
  excerpt: z.string().max(DEPENDENCY_GRAPH_LIMITS.evidenceExcerptChars).optional(),
  nodeId: dependencyNodeIdSchema.optional(),
  revision: z.string().min(1).max(256).optional(),
}).strict();

export const decisionRecordSchema = z.object({
  id: dependencyNodeIdSchema,
  repository: githubRepositoryKeySchema,
  question: z.string().trim().min(1).max(DEPENDENCY_GRAPH_LIMITS.questionChars),
  options: z.array(z.string().trim().min(1).max(DEPENDENCY_GRAPH_LIMITS.questionChars)).min(2).max(DEPENDENCY_GRAPH_LIMITS.decisionOptions),
  rationale: z.string().max(DEPENDENCY_GRAPH_LIMITS.rationaleChars),
  evidence: z.array(decisionEvidenceSchema).max(DEPENDENCY_GRAPH_LIMITS.evidenceItems),
  reversible: z.boolean(),
  owner: z.string().trim().min(1).max(256).optional(),
  requiredAuthorization: decisionAuthorizationSchema,
  state: decisionStateSchema,
  affectedNodeIds: z.array(dependencyNodeIdSchema).max(DEPENDENCY_GRAPH_LIMITS.affectedNodes),
  resolution: z.string().max(DEPENDENCY_GRAPH_LIMITS.rationaleChars).optional(),
  supersedes: dependencyNodeIdSchema.optional(),
  createdBy: z.string().trim().min(1).max(256),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  revision: z.number().int().nonnegative(),
}).strict();
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

export const dependencyDecisionWriteSchema = z.object({
  expectedGraphRevision: z.number().int().nonnegative(),
  id: dependencyNodeIdSchema,
  question: z.string().trim().min(1).max(DEPENDENCY_GRAPH_LIMITS.questionChars),
  options: z.array(z.string().trim().min(1).max(DEPENDENCY_GRAPH_LIMITS.questionChars)).min(2).max(DEPENDENCY_GRAPH_LIMITS.decisionOptions),
  rationale: z.string().max(DEPENDENCY_GRAPH_LIMITS.rationaleChars).default(''),
  evidence: z.array(decisionEvidenceSchema).max(DEPENDENCY_GRAPH_LIMITS.evidenceItems).default([]),
  reversible: z.boolean().default(false),
  owner: z.string().trim().min(1).max(256).optional(),
  requiredAuthorization: decisionAuthorizationSchema.default('agent-proposal'),
  state: decisionStateSchema.default('proposed'),
  affectedNodeIds: z.array(dependencyNodeIdSchema).max(DEPENDENCY_GRAPH_LIMITS.affectedNodes).default([]),
  resolution: z.string().max(DEPENDENCY_GRAPH_LIMITS.rationaleChars).optional(),
  supersedes: dependencyNodeIdSchema.optional(),
}).strict();
export type DependencyDecisionWrite = z.infer<typeof dependencyDecisionWriteSchema>;

export const dependencyDecisionTransitionSchema = z.object({
  expectedGraphRevision: z.number().int().nonnegative(),
  decisionId: dependencyNodeIdSchema,
  to: decisionStateSchema,
  resolution: z.string().max(DEPENDENCY_GRAPH_LIMITS.rationaleChars).optional(),
}).strict();
export type DependencyDecisionTransition = z.infer<typeof dependencyDecisionTransitionSchema>;

/** Narrow, reversible metadata-only mutation. Structural decision content has a separate approval path. */
export const dependencyDecisionMetadataPatchSchema = z.object({
  expectedGraphRevision: z.number().int().nonnegative(),
  decisionId: dependencyNodeIdSchema,
  expectedDecisionRevision: z.number().int().nonnegative(),
  expectedDecisionSha: z.string().regex(/^[a-f0-9]{64}$/i),
  rationale: z.string().trim().min(8).max(1_000),
  owner: z.string().trim().min(1).max(256).nullable().optional(),
  evidence: z.array(decisionEvidenceSchema).max(DEPENDENCY_GRAPH_LIMITS.evidenceItems).optional(),
}).strict().refine((value) => value.owner !== undefined || value.evidence !== undefined, 'at least one metadata field is required');
export type DependencyDecisionMetadataPatch = z.infer<typeof dependencyDecisionMetadataPatchSchema>;

export const dependencyDecisionMetadataRollbackSchema = z.object({
  expectedGraphRevision: z.number().int().nonnegative(),
  decisionId: dependencyNodeIdSchema,
  targetRevision: z.number().int().positive(),
}).strict();
export type DependencyDecisionMetadataRollback = z.infer<typeof dependencyDecisionMetadataRollbackSchema>;

export const dependencyCyclePlanDispatchSchema = z.object({
  expectedGraphRevision: z.number().int().nonnegative(),
  candidateId: z.string().min(1).max(128).optional(),
}).strict();
export type DependencyCyclePlanDispatch = z.infer<typeof dependencyCyclePlanDispatchSchema>;

export const dependencyCyclePlanDispatchResponseSchema = z.object({
  status: z.enum(['started', 'skipped']),
  runId: z.string().optional(),
  reason: z.string().optional(),
  fingerprint: z.string().optional(),
}).strict();
export type DependencyCyclePlanDispatchResponse = z.infer<typeof dependencyCyclePlanDispatchResponseSchema>;

export const dependencyDecisionResearchDispatchSchema = z.object({
  expectedGraphRevision: z.number().int().nonnegative(),
  decisionId: dependencyNodeIdSchema,
}).strict();
export type DependencyDecisionResearchDispatch = z.infer<typeof dependencyDecisionResearchDispatchSchema>;


const decisionNodeSchema = z.object({
  kind: z.literal('decision'),
  id: dependencyNodeIdSchema,
  repository: githubRepositoryKeySchema,
  title: z.string().max(DEPENDENCY_GRAPH_LIMITS.titleChars),
  state: decisionStateSchema,
  requiredAuthorization: decisionAuthorizationSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

const milestoneNodeSchema = z.object({
  kind: z.literal('milestone'),
  id: dependencyNodeIdSchema,
  repository: githubRepositoryKeySchema,
  key: z.string().trim().min(1).max(256),
  title: z.string().max(DEPENDENCY_GRAPH_LIMITS.titleChars),
  state: z.enum(['open', 'closed']),
  url: z.url({ protocol: /^https$/ }).optional(),
  revision: z.string().min(1).max(256),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

const externalBlockerNodeSchema = z.object({
  kind: z.literal('external-blocker'),
  id: dependencyNodeIdSchema,
  repository: githubRepositoryKeySchema,
  key: z.string().trim().min(1).max(256),
  title: z.string().max(DEPENDENCY_GRAPH_LIMITS.titleChars),
  state: z.enum(['open', 'resolved', 'unknown']),
  owner: z.string().trim().min(1).max(256).optional(),
  url: z.url({ protocol: /^https$/ }).optional(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const dependencyGraphNodeSchema = z.discriminatedUnion('kind', [
  issueNodeSchema,
  decisionNodeSchema,
  milestoneNodeSchema,
  externalBlockerNodeSchema,
]);
export type DependencyGraphNode = z.infer<typeof dependencyGraphNodeSchema>;

export const dependencyEdgeKindSchema = z.enum([
  'BLOCKS',
  'PART_OF',
  'RELATED_TO',
  'INFORMS',
  'SUPERSEDES',
  'CONFLICTS',
]);
export type DependencyEdgeKind = z.infer<typeof dependencyEdgeKindSchema>;

export const dependencyGraphEdgeSchema = z.object({
  id: z.uuid(),
  kind: dependencyEdgeKindSchema,
  from: dependencyNodeIdSchema,
  to: dependencyNodeIdSchema,
  direction: z.literal('from-to'),
  provenance: provenanceSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type DependencyGraphEdge = z.infer<typeof dependencyGraphEdgeSchema>;

export const dependencySimulationInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  addEdges: z.array(dependencyGraphEdgeSchema).max(100).default([]),
  removeEdgeIds: z.array(z.string().min(1).max(768)).max(100).default([]),
  completeNodeIds: z.array(dependencyNodeIdSchema).max(100).default([]),
  resolveDecisionIds: z.array(dependencyNodeIdSchema).max(100).default([]),
}).strict();
export type DependencySimulationInput = z.infer<typeof dependencySimulationInputSchema>;

/** The sole eligibility predicate used by readiness and scheduler integrations. */
export function isVerifiedBlockingEdge(edge: DependencyGraphEdge): boolean {
  return edge.kind === 'BLOCKS'
    && edge.provenance.authority === 'verified'
    && edge.provenance.origin !== 'model';
}

export const dependencyGraphSnapshotSchema = z.object({
  schemaVersion: z.literal(DEPENDENCY_GRAPH_SCHEMA_VERSION),
  repository: githubRepositoryKeySchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  source: z.object({
    status: z.enum(['fresh', 'stale', 'offline', 'unknown']),
    lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).optional(),
    watermark: z.string().max(512).optional(),
    warning: z.string().max(1_000).optional(),
  }).strict(),
  nodes: z.array(dependencyGraphNodeSchema),
  edges: z.array(dependencyGraphEdgeSchema),
  decisions: z.array(decisionRecordSchema),
}).strict();
export type DependencyGraphSnapshot = z.infer<typeof dependencyGraphSnapshotSchema>;

/** Generated from the same contracts consumed by the service and browser. */
export const dependencyGraphNodeJsonSchema = z.toJSONSchema(dependencyGraphNodeSchema);
export const dependencyGraphEdgeJsonSchema = z.toJSONSchema(dependencyGraphEdgeSchema);
export const decisionRecordJsonSchema = z.toJSONSchema(decisionRecordSchema);
export const dependencyGraphSnapshotJsonSchema = z.toJSONSchema(dependencyGraphSnapshotSchema);

/** Cross-field identity checks kept beside the JSON contracts so non-Zod consumers can enforce them too. */
export function hasValidDependencyNodeIdentity(node: DependencyGraphNode): boolean {
  const key = 'number' in node
    ? node.number
    : node.kind === 'decision'
      ? node.id.split(':').at(-1)
      : node.key;
  return node.id === `${node.kind}:${repositoryPath(node.repository)}:${key}`;
}

export function validateDependencyGraphSnapshot(snapshot: DependencyGraphSnapshot): string[] {
  const errors: string[] = [];
  const nodes = new Map<string, DependencyGraphNode>();
  for (const node of snapshot.nodes) {
    if (nodes.has(node.id)) errors.push(`duplicate node ${node.id}`);
    if (!hasValidDependencyNodeIdentity(node)) errors.push(`node identity does not match kind/repository/key: ${node.id}`);
    nodes.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodes.has(edge.from) && dependencyNodeIdSchema.safeParse(edge.from).success && isDependencyNodeInRepository(edge.from as DependencyNodeId, snapshot.repository)) {
      errors.push(`edge ${edge.id} has missing prerequisite ${edge.from}`);
    }
    if (!nodes.has(edge.to) && dependencyNodeIdSchema.safeParse(edge.to).success && isDependencyNodeInRepository(edge.to as DependencyNodeId, snapshot.repository)) {
      errors.push(`edge ${edge.id} has missing dependent ${edge.to}`);
    }
    if (edge.provenance.authority === 'verified' && edge.provenance.origin === 'model') {
      errors.push(`model-origin edge ${edge.id} cannot be verified`);
    }
  }
  const decisionIds = new Set<string>();
  for (const decision of snapshot.decisions) {
    if (decisionIds.has(decision.id)) errors.push(`duplicate decision ${decision.id}`);
    decisionIds.add(decision.id);
    if (decision.id !== `decision:${repositoryPath(decision.repository)}:${decision.id.split(':').at(-1)}`) {
      errors.push(`decision identity does not match repository: ${decision.id}`);
    }
  }
  return errors;
}

const decisionTransitions: Record<DecisionState, readonly DecisionState[]> = {
  proposed: ['approved', 'rejected'],
  approved: ['resolved', 'deferred', 'rejected'],
  resolved: ['reopened', 'superseded'],
  deferred: ['reopened', 'resolved', 'superseded'],
  reopened: ['approved', 'resolved', 'deferred', 'rejected'],
  superseded: [],
  rejected: ['reopened'],
};

export function canTransitionDecisionState(from: DecisionState, to: DecisionState): boolean {
  return decisionTransitions[from].includes(to);
}
