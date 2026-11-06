import { z } from 'zod';

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const gitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const cleanText = (max: number, min = 1) => z.string().min(min).max(max).refine((value) => value.trim() === value, 'must not have surrounding whitespace');
const relativePathSchema = z.string().min(1).max(1_024).refine((path) => {
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((part) => part !== '.' && part !== '..' && part.length > 0);
}, 'must be a normalized relative path');

const sourceSchema = z.object({
  repository: cleanText(512).regex(/^[^/\s]+\/[^/\s]+$/),
  sha: gitShaSchema,
  gitObjectFormat: z.enum(['sha1', 'sha256']),
  ref: cleanText(512),
}).strict().superRefine((source, ctx) => {
  const expected = source.gitObjectFormat === 'sha1' ? 40 : 64;
  if (source.sha.length !== expected) ctx.addIssue({ code: 'custom', path: ['sha'], message: `must be ${expected} hex characters for ${source.gitObjectFormat}` });
});

const fileEntrySchema = z.object({
  path: relativePathSchema,
  byteSize: z.number().int().nonnegative(),
  sha256: sha256Schema,
}).strict();

const verificationEvidenceSchema = z.object({
  /** Matches the additive resultVersion/status contract in #49. */
  resultVersion: z.literal(1),
  status: z.literal('passed'),
  digest: sha256Schema,
  evidenceRef: relativePathSchema,
}).strict();

export const factoryReleaseManifestSchema = z.object({
  schemaVersion: z.literal('factory-release-manifest/v1'),
  source: sourceSchema,
  artifact: z.object({
    format: z.enum(['tar', 'directory']),
    byteSize: z.number().int().nonnegative(),
    sha256: sha256Schema,
  }).strict(),
  files: z.array(fileEntrySchema).min(1).max(100_000),
  build: z.object({
    id: cleanText(128),
    builder: cleanText(128),
    builderVersion: cleanText(128),
    workflow: cleanText(128),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  }).strict(),
  compatibility: z.object({
    cezarApi: cleanText(256),
    requiredCapabilities: z.array(cleanText(128)).max(128),
  }).strict(),
  verification: verificationEvidenceSchema,
  manifestDigest: sha256Schema,
}).strict().superRefine((manifest, ctx) => {
  if (Date.parse(manifest.build.completedAt) < Date.parse(manifest.build.startedAt)) {
    ctx.addIssue({ code: 'custom', path: ['build', 'completedAt'], message: 'must not precede startedAt' });
  }
  const paths = new Set<string>();
  let previous = '';
  for (const [index, file] of manifest.files.entries()) {
    if (paths.has(file.path)) ctx.addIssue({ code: 'custom', path: ['files', index, 'path'], message: 'duplicate file path' });
    if (index > 0 && file.path <= previous) ctx.addIssue({ code: 'custom', path: ['files', index, 'path'], message: 'file paths must be sorted in ordinal order' });
    paths.add(file.path);
    previous = file.path;
  }
  if (new Set(manifest.compatibility.requiredCapabilities).size !== manifest.compatibility.requiredCapabilities.length) {
    ctx.addIssue({ code: 'custom', path: ['compatibility', 'requiredCapabilities'], message: 'capabilities must be unique' });
  }
});
export type FactoryReleaseManifest = z.infer<typeof factoryReleaseManifestSchema>;

export const factoryReleaseStateSchema = z.object({
  schemaVersion: z.literal('factory-release-state/v1'),
  sourceSha: gitShaSchema,
  manifestDigest: sha256Schema,
  state: z.enum(['built', 'verified', 'quarantined']),
  verification: verificationEvidenceSchema.optional(),
  reasonCode: cleanText(128).optional(),
  reason: cleanText(2_000, 0).optional(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((release, ctx) => {
  if (release.state === 'verified' && !release.verification) ctx.addIssue({ code: 'custom', path: ['verification'], message: 'verified release state requires passing verification evidence' });
  if (release.state !== 'quarantined' && (release.reasonCode || release.reason)) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'reason fields are only valid for quarantined state' });
  if (release.state === 'quarantined' && !release.reasonCode) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'quarantined state requires a reason code' });
});
export type FactoryReleaseState = z.infer<typeof factoryReleaseStateSchema>;

export const factoryReleaseChannelPointerSchema = z.object({
  schemaVersion: z.literal('factory-release-channel-pointer/v1'),
  channel: z.enum(['dev', 'stable']),
  currentSha: gitShaSchema,
  currentPath: z.string().min(1).max(4_096),
  lastGoodSha: gitShaSchema,
  lastGoodPath: z.string().min(1).max(4_096),
  updatedAt: z.string().datetime(),
}).strict();
export type FactoryReleaseChannelPointer = z.infer<typeof factoryReleaseChannelPointerSchema>;

export const factoryReleaseProvenanceSchema = z.object({
  channel: z.enum(['dev', 'stable']),
  sourceSha: gitShaSchema,
  manifestDigest: sha256Schema,
  resolvedAt: z.string().datetime(),
}).strict();
export type FactoryReleaseProvenance = z.infer<typeof factoryReleaseProvenanceSchema>;

const compatibilityObservationSchema = z.object({
  status: z.enum(['compatible', 'incompatible']),
  cezarVersion: cleanText(128).optional(),
  capabilities: z.array(cleanText(128)).max(128),
  reasonCode: cleanText(128).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'incompatible' && !value.reasonCode) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'incompatible result requires a reason code' });
});

export const factoryDeploymentReceiptSchema = z.object({
  schemaVersion: z.literal('factory-deployment-receipt/v1'),
  receiptId: cleanText(128),
  targetId: cleanText(256),
  channel: cleanText(64),
  desiredSha: gitShaSchema,
  actualSha: gitShaSchema.nullable(),
  observedSha: gitShaSchema.nullable(),
  artifactDigest: sha256Schema,
  idempotencyKey: sha256Schema,
  activationGeneration: z.number().int().positive(),
  attempt: z.number().int().positive(),
  state: z.enum(['pending', 'staged', 'activating', 'active', 'incompatible', 'failed', 'rolled_back']),
  compatibility: compatibilityObservationSchema.optional(),
  requestedAt: z.string().datetime(),
  stagedAt: z.string().datetime().optional(),
  activatedAt: z.string().datetime().optional(),
  observedAt: z.string().datetime().optional(),
  supersedesReceiptId: cleanText(128).optional(),
  reasonCode: cleanText(128).optional(),
  message: cleanText(2_000, 0).optional(),
  logRef: cleanText(256).optional(),
}).strict().superRefine((receipt, ctx) => {
  const times = [receipt.requestedAt, receipt.stagedAt, receipt.activatedAt, receipt.observedAt].filter((value): value is string => Boolean(value)).map(Date.parse);
  if (times.some((value, index) => index > 0 && value < times[index - 1]!)) ctx.addIssue({ code: 'custom', message: 'receipt event timestamps must be ordered' });
  if (receipt.activatedAt && !receipt.stagedAt) ctx.addIssue({ code: 'custom', path: ['stagedAt'], message: 'activation requires a stagedAt event' });
  if (receipt.observedAt && !receipt.activatedAt) ctx.addIssue({ code: 'custom', path: ['activatedAt'], message: 'observation requires an activatedAt event' });
  if (receipt.state === 'active') {
    if (!receipt.stagedAt || !receipt.activatedAt || !receipt.observedAt) ctx.addIssue({ code: 'custom', path: ['state'], message: 'active receipt requires staged, activated and observed timestamps' });
    if (!receipt.compatibility || receipt.compatibility.status !== 'compatible') ctx.addIssue({ code: 'custom', path: ['compatibility'], message: 'active receipt requires compatible target evidence' });
    if (receipt.actualSha !== receipt.desiredSha || receipt.observedSha !== receipt.desiredSha) ctx.addIssue({ code: 'custom', path: ['observedSha'], message: 'active receipt requires desired, actual and observed SHAs to match' });
  }
  if (receipt.state === 'incompatible' && receipt.compatibility?.status !== 'incompatible') ctx.addIssue({ code: 'custom', path: ['compatibility'], message: 'incompatible receipt requires incompatible target evidence' });
});
export type FactoryDeploymentReceipt = z.infer<typeof factoryDeploymentReceiptSchema>;

export const factoryReleaseLeaseSchema = z.object({
  schemaVersion: z.literal('factory-release-lease/v1'),
  runId: cleanText(128),
  projectId: cleanText(256),
  channel: cleanText(64),
  sourceSha: gitShaSchema,
  state: z.enum(['active', 'released', 'expired', 'reconciled']),
  acquiredAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
  reconciledAt: z.string().datetime().optional(),
}).strict().superRefine((lease, ctx) => {
  if (Date.parse(lease.heartbeatAt) < Date.parse(lease.acquiredAt)) ctx.addIssue({ code: 'custom', path: ['heartbeatAt'], message: 'must not precede acquiredAt' });
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.heartbeatAt)) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'must follow heartbeatAt' });
  if (lease.state === 'released' && !lease.releasedAt) ctx.addIssue({ code: 'custom', path: ['releasedAt'], message: 'released lease requires releasedAt' });
  if (lease.state === 'reconciled' && !lease.reconciledAt) ctx.addIssue({ code: 'custom', path: ['reconciledAt'], message: 'reconciled lease requires reconciledAt' });
});
export type FactoryReleaseLease = z.infer<typeof factoryReleaseLeaseSchema>;

export type VersionedContractParse<T> =
  | { status: 'valid'; data: T }
  | { status: 'invalid'; issues: z.ZodIssue[] }
  | { status: 'unknown-schema'; schemaVersion: string };

function parseVersioned<T>(input: unknown, expected: string, schema: z.ZodType<T>): VersionedContractParse<T> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 'invalid', issues: [] };
  const version = (input as Record<string, unknown>).schemaVersion;
  if (typeof version === 'string' && version !== expected) return { status: 'unknown-schema', schemaVersion: version };
  const parsed = schema.safeParse(input);
  return parsed.success ? { status: 'valid', data: parsed.data } : { status: 'invalid', issues: parsed.error.issues };
}

export const parseFactoryReleaseManifest = (input: unknown) => parseVersioned(input, 'factory-release-manifest/v1', factoryReleaseManifestSchema);
export const parseFactoryReleaseState = (input: unknown) => parseVersioned(input, 'factory-release-state/v1', factoryReleaseStateSchema);
export const parseFactoryDeploymentReceipt = (input: unknown) => parseVersioned(input, 'factory-deployment-receipt/v1', factoryDeploymentReceiptSchema);
export const parseFactoryReleaseLease = (input: unknown) => parseVersioned(input, 'factory-release-lease/v1', factoryReleaseLeaseSchema);

export async function verifyFactoryDeploymentReceipt(input: unknown): Promise<
  | { valid: true; data: FactoryDeploymentReceipt }
  | { valid: false; reason: 'invalid-receipt' | 'unknown-schema' | 'idempotency-key-mismatch' }
> {
  const parsed = parseFactoryDeploymentReceipt(input);
  if (parsed.status === 'unknown-schema') return { valid: false, reason: 'unknown-schema' };
  if (parsed.status !== 'valid') return { valid: false, reason: 'invalid-receipt' };
  const expected = await computeFactoryActivationIdempotencyKey(parsed.data);
  if (expected !== parsed.data.idempotencyKey) return { valid: false, reason: 'idempotency-key-mismatch' };
  return { valid: true, data: parsed.data };
}

export type FactoryArtifactEntry = { path: string; kind: 'file' | 'symlink'; bytes: Uint8Array };
export type ManifestIntegrityResult =
  | { valid: true }
  | { valid: false; reason: 'invalid-manifest' | 'unknown-schema' | 'manifest-digest-mismatch' | 'artifact-digest-mismatch' | 'verification-evidence-missing' | 'verification-evidence-digest-mismatch' | 'verification-evidence-invalid' | 'file-list-mismatch' | 'file-digest-mismatch' | 'unsafe-artifact-entry' };

/** RFC 8785 JSON Canonicalization Scheme for the JSON values accepted by these contracts. */
export function canonicalizeFactoryJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    const json = JSON.stringify(value);
    if (json === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('value is not valid JSON data');
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeFactoryJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeFactoryJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('value is not valid JSON data');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  const cryptoApi = (globalThis as unknown as { crypto?: { subtle?: { digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> } } }).crypto;
  if (!cryptoApi?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await cryptoApi.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function encodeUtf8(value: string): Uint8Array {
  const Encoder = (globalThis as unknown as { TextEncoder?: new () => { encode(input: string): Uint8Array } }).TextEncoder;
  if (!Encoder) throw new Error('UTF-8 encoder is unavailable');
  return new Encoder().encode(value);
}

function decodeUtf8(bytes: Uint8Array): string {
  const Decoder = (globalThis as unknown as { TextDecoder?: new () => { decode(input: Uint8Array): string } }).TextDecoder;
  if (!Decoder) throw new Error('UTF-8 decoder is unavailable');
  return new Decoder().decode(bytes);
}

export async function computeFactoryManifestDigest(manifest: Omit<FactoryReleaseManifest, 'manifestDigest'> | FactoryReleaseManifest): Promise<string> {
  const { manifestDigest: _ignored, ...unsigned } = manifest as FactoryReleaseManifest;
  return sha256(encodeUtf8(canonicalizeFactoryJson(unsigned)));
}

export async function computeFactoryActivationIdempotencyKey(input: {
  targetId: string;
  channel: string;
  desiredSha: string;
  activationGeneration: number;
}): Promise<string> {
  const tuple = [input.targetId, input.channel, input.desiredSha, input.activationGeneration];
  return sha256(encodeUtf8(canonicalizeFactoryJson(tuple)));
}

export type FactoryVerificationEvidence = { path: string; bytes: Uint8Array };

/** Check a validated manifest against the exact bundle and extracted entries before activation. */
export async function verifyFactoryReleaseManifest(
  input: unknown,
  bundle: Uint8Array,
  entries: readonly FactoryArtifactEntry[],
  evidence?: FactoryVerificationEvidence,
): Promise<ManifestIntegrityResult> {
  const parsed = parseFactoryReleaseManifest(input);
  if (parsed.status === 'unknown-schema') return { valid: false, reason: 'unknown-schema' };
  if (parsed.status !== 'valid') return { valid: false, reason: 'invalid-manifest' };
  const manifest = parsed.data;
  if (await computeFactoryManifestDigest(manifest) !== manifest.manifestDigest) return { valid: false, reason: 'manifest-digest-mismatch' };
  if (bundle.byteLength !== manifest.artifact.byteSize || await sha256(bundle) !== manifest.artifact.sha256) return { valid: false, reason: 'artifact-digest-mismatch' };
  if (!evidence) return { valid: false, reason: 'verification-evidence-missing' };
  if (evidence.path !== manifest.verification.evidenceRef || await sha256(evidence.bytes) !== manifest.verification.digest) return { valid: false, reason: 'verification-evidence-digest-mismatch' };
  let evidenceRecord: unknown;
  try { evidenceRecord = JSON.parse(decodeUtf8(evidence.bytes)); } catch { return { valid: false, reason: 'verification-evidence-invalid' }; }
  if (!evidenceRecord || typeof evidenceRecord !== 'object' || (evidenceRecord as Record<string, unknown>).resultVersion !== manifest.verification.resultVersion || (evidenceRecord as Record<string, unknown>).status !== manifest.verification.status) {
    return { valid: false, reason: 'verification-evidence-invalid' };
  }
  if (entries.some((entry) => entry.kind !== 'file')) return { valid: false, reason: 'unsafe-artifact-entry' };
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || paths.length !== manifest.files.length || paths.some((path, index) => path !== manifest.files[index]?.path)) return { valid: false, reason: 'file-list-mismatch' };
  for (const [index, entry] of entries.entries()) {
    const declared = manifest.files[index]!;
    if (entry.bytes.byteLength !== declared.byteSize || await sha256(entry.bytes) !== declared.sha256) return { valid: false, reason: 'file-digest-mismatch' };
  }
  return { valid: true };
}
