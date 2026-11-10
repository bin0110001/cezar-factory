import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CodingEvidenceReference } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;

export interface CodingRunArtifactReference extends CodingEvidenceReference {
  kind: 'artifact';
  evidenceId: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  reference: string;
  createdAt: string;
  expiresAt: string;
}

export type CodingRunArtifactRead =
  | { status: 'available'; bytes: Uint8Array; reference: CodingRunArtifactReference }
  | { status: 'expired'; reference: CodingRunArtifactReference }
  | { status: 'missing' }
  | { status: 'corrupt'; reason: 'metadata-invalid' | 'size-mismatch' | 'digest-mismatch' };

function storageRoot(home?: string): string {
  return join(home ?? cezarHomeDir(), 'coding-run-artifacts');
}

function validRetentionDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('artifact retention days must be an integer from 1 to 3650');
  return days;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function contentPath(root: string, sha256: string): string {
  return join(root, 'sha256', sha256.slice(0, 2), sha256);
}

function metadataPath(root: string, sha256: string): string {
  return join(root, 'metadata', `${sha256}.json`);
}

/** Store a bounded evidence blob by content digest. Callers must redact before storage. */
export async function storeCodingRunArtifact(options: {
  content: Uint8Array;
  mediaType: string;
  evidenceId?: string;
  home?: string;
  retentionDays?: number;
  now?: Date;
}): Promise<CodingRunArtifactReference> {
  if (!(options.content instanceof Uint8Array) || options.content.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`coding-run artifacts must be bytes no larger than ${MAX_ARTIFACT_BYTES} bytes`);
  }
  if (!options.mediaType.trim() || options.mediaType.length > 128) throw new Error('artifact media type is invalid');
  const configuredDays = Number(process.env.CEZ_CODING_RUN_ARTIFACT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  const retentionDays = validRetentionDays(options.retentionDays ?? configuredDays);
  const root = storageRoot(options.home);
  const sha256 = digest(options.content);
  const blobPath = contentPath(root, sha256);
  const metaPath = metadataPath(root, sha256);
  await mkdir(dirname(blobPath), { recursive: true });
  await mkdir(dirname(metaPath), { recursive: true });
  const temporaryPath = `${blobPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, options.content, { flag: 'wx' });
    await rename(temporaryPath, blobPath).catch(async () => {
      const existing = await readFile(blobPath);
      if (digest(existing) !== sha256) throw new Error('content-addressed artifact path contains different bytes');
    });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  const now = options.now ?? new Date();
  let createdAt = now.toISOString();
  let expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    const existing = JSON.parse(await readFile(metaPath, 'utf8')) as Partial<CodingRunArtifactReference>;
    if (existing.schemaVersion === 1 && typeof existing.createdAt === 'string' && typeof existing.expiresAt === 'string') {
      createdAt = existing.createdAt;
      expiresAt = new Date(Math.max(Date.parse(existing.expiresAt), Date.parse(expiresAt))).toISOString();
    }
  } catch { /* new metadata or malformed metadata is replaced with a fresh truthful record */ }
  const reference: CodingRunArtifactReference = {
    schemaVersion: 1, evidenceId: options.evidenceId ?? randomUUID(), kind: 'artifact',
    sha256, bytes: options.content.byteLength, mediaType: options.mediaType,
    reference: `sha256/${sha256.slice(0, 2)}/${sha256}`, createdAt, expiresAt,
  };
  await writeFile(metaPath, `${JSON.stringify(reference)}\n`);
  return reference;
}

/** Return expired and damaged evidence as explicit states; never silently substitute content. */
export async function readCodingRunArtifact(options: {
  reference: CodingRunArtifactReference;
  home?: string;
  now?: Date;
}): Promise<CodingRunArtifactRead> {
  const ref = options.reference;
  if (ref.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.reference !== `sha256/${ref.sha256.slice(0, 2)}/${ref.sha256}`
    || !Number.isInteger(ref.bytes) || ref.bytes < 0 || !Number.isFinite(Date.parse(ref.expiresAt))) {
    return { status: 'corrupt', reason: 'metadata-invalid' };
  }
  if (Date.parse(options.now?.toISOString() ?? new Date().toISOString()) >= Date.parse(ref.expiresAt)) return { status: 'expired', reference: ref };
  try {
    const bytes = await readFile(contentPath(storageRoot(options.home), ref.sha256));
    if (bytes.byteLength !== ref.bytes) return { status: 'corrupt', reason: 'size-mismatch' };
    if (digest(bytes) !== ref.sha256) return { status: 'corrupt', reason: 'digest-mismatch' };
    return { status: 'available', bytes, reference: ref };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw error;
  }
}

/** Delete expired blobs and metadata; active run references are retained by extending expiry on put. */
export async function pruneCodingRunArtifacts(options: { home?: string; now?: Date }): Promise<{ deleted: number; retained: number; invalid: number }> {
  const root = storageRoot(options.home);
  const directory = join(root, 'metadata');
  const now = options.now ?? new Date();
  let deleted = 0; let retained = 0; let invalid = 0;
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deleted, retained, invalid };
    throw error;
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) { invalid += 1; continue; }
    const metaPath = join(directory, name);
    let ref: CodingRunArtifactReference;
    try {
      ref = JSON.parse(await readFile(metaPath, 'utf8')) as CodingRunArtifactReference;
      if (ref.schemaVersion !== 1 || ref.sha256 !== name.slice(0, 64) || !Number.isFinite(Date.parse(ref.expiresAt))) throw new Error('invalid artifact metadata');
    } catch { invalid += 1; continue; }
    if (Date.parse(ref.expiresAt) > now.getTime()) { retained += 1; continue; }
    await rm(contentPath(root, ref.sha256), { force: true });
    await rm(metaPath, { force: true });
    deleted += 1;
  }
  return { deleted, retained, invalid };
}
