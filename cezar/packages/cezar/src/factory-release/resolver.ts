import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  computeFactoryManifestDigest,
  factoryReleaseChannelPointerSchema,
  parseFactoryReleaseManifest,
  parseFactoryReleaseState,
} from '@open-mercato/cezar-contract';
import { loadWorkspaceConfig } from '../workspace/config.ts';

export type FactoryChannel = 'dev' | 'stable';
export interface FactoryReleaseResolution {
  projectId: string;
  channel: FactoryChannel;
  sourceSha: string;
  manifestDigest: string;
  releaseRoot: string;
  runtimeRoot: string;
  resolvedAt: string;
}

export function factoryReleaseProvenance(resolution: FactoryReleaseResolution) {
  return {
    channel: resolution.channel,
    sourceSha: resolution.sourceSha,
    manifestDigest: resolution.manifestDigest,
    resolvedAt: resolution.resolvedAt,
  } as const;
}

export type FactoryReleaseResolutionCode =
  | 'unknown-project'
  | 'invalid-channel'
  | 'release-store-not-configured'
  | 'pointer-missing'
  | 'pointer-invalid'
  | 'release-path-mismatch'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'manifest-digest-mismatch'
  | 'release-state-invalid'
  | 'artifact-invalid'
  | 'incompatible-release'
  | 'verification-evidence-invalid';

export class FactoryReleaseResolutionError extends Error {
  constructor(readonly code: FactoryReleaseResolutionCode, message: string) {
    super(message);
    this.name = 'FactoryReleaseResolutionError';
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function readJson(path: string, missingCode: FactoryReleaseResolutionCode): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FactoryReleaseResolutionError(missingCode, `required Factory release file is missing: ${path}`);
    }
    throw new FactoryReleaseResolutionError(missingCode, `could not read Factory release file ${path}: ${String(error)}`);
  }
}

function containedPath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new FactoryReleaseResolutionError('manifest-invalid', 'manifest contains an unsafe relative path');
  }
  const path = resolve(root, ...relative.split('/'));
  const comparisonPath = process.platform === 'win32' ? path.toLowerCase() : path;
  const comparisonRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  if (comparisonPath !== comparisonRoot && !comparisonPath.startsWith(`${comparisonRoot}${sep}`)) {
    throw new FactoryReleaseResolutionError('manifest-invalid', 'manifest path escapes the release root');
  }
  return path;
}

async function verifyRelease(storeRoot: string, projectId: string, channel: FactoryChannel, pinned?: { sourceSha: string; manifestDigest: string }): Promise<FactoryReleaseResolution> {
  let canonicalStoreRoot: string;
  try { canonicalStoreRoot = await realpath(storeRoot); }
  catch {
    throw new FactoryReleaseResolutionError(
      pinned ? 'release-path-mismatch' : 'pointer-missing',
      pinned ? 'Factory release store is unavailable' : `channel pointer for ${channel} is unavailable`,
    );
  }
  let sourceSha = pinned?.sourceSha;
  if (!pinned) {
    const pointerPath = join(storeRoot, 'channels', `${channel}.json`);
    const pointerResult = factoryReleaseChannelPointerSchema.safeParse(await readJson(pointerPath, 'pointer-missing'));
    if (!pointerResult.success || pointerResult.data.channel !== channel) {
      throw new FactoryReleaseResolutionError('pointer-invalid', `channel pointer for ${channel} is malformed or mismatched`);
    }
    const pointer = pointerResult.data;
    sourceSha = pointer.currentSha;
    const expectedPath = resolve(canonicalStoreRoot, 'releases', sourceSha);
    let canonicalPointerPath: string;
    try { canonicalPointerPath = await realpath(pointer.currentPath); }
    catch { throw new FactoryReleaseResolutionError('release-path-mismatch', 'channel pointer release directory is unavailable'); }
    const normalizedPointerPath = process.platform === 'win32' ? canonicalPointerPath.toLowerCase() : canonicalPointerPath;
    const normalizedExpectedPath = process.platform === 'win32' ? expectedPath.toLowerCase() : expectedPath;
    if (normalizedPointerPath !== normalizedExpectedPath) {
      throw new FactoryReleaseResolutionError('release-path-mismatch', 'channel pointer path does not match its full SHA');
    }
  }
  if (!sourceSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha)) {
    throw new FactoryReleaseResolutionError('pointer-invalid', 'selected Factory SHA is malformed');
  }
  const releaseRoot = resolve(canonicalStoreRoot, 'releases', sourceSha);
  let actualReleaseRoot: string;
  try {
    actualReleaseRoot = await realpath(releaseRoot);
    if (!(await stat(actualReleaseRoot)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new FactoryReleaseResolutionError('release-path-mismatch', 'channel pointer release directory is unavailable');
  }
  const actualPath = process.platform === 'win32' ? actualReleaseRoot.toLowerCase() : actualReleaseRoot;
  const expectedPath = process.platform === 'win32' ? releaseRoot.toLowerCase() : releaseRoot;
  if (actualPath !== expectedPath) {
    throw new FactoryReleaseResolutionError('release-path-mismatch', 'release directory resolves outside its immutable path');
  }

  const manifestResult = parseFactoryReleaseManifest(await readJson(join(releaseRoot, 'manifest.json'), 'manifest-missing'));
  if (manifestResult.status !== 'valid' || manifestResult.data.source.sha !== sourceSha) {
    throw new FactoryReleaseResolutionError('manifest-invalid', 'release manifest is invalid or names a different source SHA');
  }
  const manifest = manifestResult.data;
  const supportedCapabilities = new Set(['shared-factory-runtime-v1']);
  const unsupportedCapabilities = manifest.compatibility.requiredCapabilities.filter((capability) => !supportedCapabilities.has(capability));
  if (unsupportedCapabilities.length) {
    throw new FactoryReleaseResolutionError('incompatible-release', `Factory release requires unsupported capabilities: ${unsupportedCapabilities.join(', ')}`);
  }
  if (await computeFactoryManifestDigest(manifest) !== manifest.manifestDigest) {
    throw new FactoryReleaseResolutionError('manifest-digest-mismatch', 'release manifest digest does not match its contents');
  }
  if (pinned && manifest.manifestDigest !== pinned.manifestDigest) {
    throw new FactoryReleaseResolutionError('manifest-digest-mismatch', 'pinned release manifest changed after task creation');
  }
  const stateResult = parseFactoryReleaseState(await readJson(join(releaseRoot, 'state.json'), 'release-state-invalid'));
  if (stateResult.status !== 'valid' || stateResult.data.state !== 'verified' || stateResult.data.sourceSha !== sourceSha || stateResult.data.manifestDigest !== manifest.manifestDigest || stateResult.data.verification?.digest !== manifest.verification.digest) {
    throw new FactoryReleaseResolutionError('release-state-invalid', 'release state is not verified against the selected manifest');
  }

  const artifactPath = join(releaseRoot, 'artifact.tar');
  let artifact: Uint8Array;
  try { artifact = await readFile(artifactPath); } catch { throw new FactoryReleaseResolutionError('artifact-invalid', 'release artifact is missing or unreadable'); }
  if (artifact.byteLength !== manifest.artifact.byteSize || sha256(artifact) !== manifest.artifact.sha256) {
    throw new FactoryReleaseResolutionError('artifact-invalid', 'release artifact size or digest does not match its manifest');
  }
  const evidencePath = containedPath(releaseRoot, manifest.verification.evidenceRef);
  let evidence: Uint8Array;
  try { evidence = await readFile(evidencePath); } catch { throw new FactoryReleaseResolutionError('verification-evidence-invalid', 'release verification evidence is missing or unreadable'); }
  if (sha256(evidence) !== manifest.verification.digest) {
    throw new FactoryReleaseResolutionError('verification-evidence-invalid', 'release verification evidence digest does not match its manifest');
  }
  let evidenceRecord: unknown;
  try { evidenceRecord = JSON.parse(Buffer.from(evidence).toString('utf8')); } catch { throw new FactoryReleaseResolutionError('verification-evidence-invalid', 'release verification evidence is malformed JSON'); }
  if (!evidenceRecord || typeof evidenceRecord !== 'object' || (evidenceRecord as Record<string, unknown>).status !== 'passed' || (evidenceRecord as Record<string, unknown>).commitSha !== sourceSha) {
    throw new FactoryReleaseResolutionError('verification-evidence-invalid', 'release evidence does not attest to the selected passing SHA');
  }
  return {
    projectId,
    channel,
    sourceSha,
    manifestDigest: manifest.manifestDigest,
    releaseRoot,
    runtimeRoot: releaseRoot,
    resolvedAt: new Date().toISOString(),
  };
}

/** Resolve the channel from the Cezar workspace registry and pin its immutable artifact. */
export async function resolveFactoryRelease(
  projectId: string,
  options: { env?: NodeJS.ProcessEnv; projects?: Awaited<ReturnType<typeof loadWorkspaceConfig>>['projects'] } = {},
): Promise<FactoryReleaseResolution> {
  const env = options.env ?? process.env;
  const projects = options.projects ?? (await loadWorkspaceConfig()).projects;
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) throw new FactoryReleaseResolutionError('unknown-project', `unknown project: ${projectId}`);
  const channel = project.factoryChannel ?? 'stable';
  if (channel !== 'dev' && channel !== 'stable') throw new FactoryReleaseResolutionError('invalid-channel', `unsupported Factory channel for project ${projectId}`);
  const configuredStore = env.CEZ_FACTORY_RELEASE_STORE;
  if (!configuredStore?.trim()) throw new FactoryReleaseResolutionError('release-store-not-configured', 'CEZ_FACTORY_RELEASE_STORE is not configured');
  const storeRoot = resolve(configuredStore);
  return verifyRelease(storeRoot, projectId, channel);
}

/** Keep older installations on the shared mount until they opt into channel-backed releases. */
export async function resolveConfiguredFactoryRelease(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FactoryReleaseResolution | undefined> {
  const { projects } = await loadWorkspaceConfig();
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) throw new FactoryReleaseResolutionError('unknown-project', `unknown project: ${projectId}`);
  if (!env.CEZ_FACTORY_RELEASE_STORE?.trim() && project.factoryChannel === undefined) return undefined;
  return resolveFactoryRelease(projectId, { env, projects });
}

/** Verify the exact saved artifact when a queued or resumed task returns after a channel switch. */
export async function resolvePinnedFactoryRelease(
  projectId: string,
  pin: { channel: FactoryChannel; sourceSha: string; manifestDigest: string },
  options: { env?: NodeJS.ProcessEnv; projects?: Awaited<ReturnType<typeof loadWorkspaceConfig>>['projects'] } = {},
): Promise<FactoryReleaseResolution> {
  const env = options.env ?? process.env;
  const projects = options.projects ?? (await loadWorkspaceConfig()).projects;
  if (!projects.some((entry) => entry.id === projectId)) throw new FactoryReleaseResolutionError('unknown-project', `unknown project: ${projectId}`);
  if (pin.channel !== 'dev' && pin.channel !== 'stable') throw new FactoryReleaseResolutionError('invalid-channel', `unsupported Factory channel: ${String(pin.channel)}`);
  if (!env.CEZ_FACTORY_RELEASE_STORE?.trim()) throw new FactoryReleaseResolutionError('release-store-not-configured', 'CEZ_FACTORY_RELEASE_STORE is not configured for this pinned run');
  return verifyRelease(resolve(env.CEZ_FACTORY_RELEASE_STORE), projectId, pin.channel, pin);
}

export function runtimeEnvironmentForFactoryRelease(resolution: FactoryReleaseResolution): Record<string, string> {
  return {
    FACTORY_RUNTIME_ROOT: resolution.runtimeRoot,
    CEZ_FACTORY_CHANNEL: resolution.channel,
    CEZ_FACTORY_SHA: resolution.sourceSha,
    CEZ_FACTORY_MANIFEST_DIGEST: resolution.manifestDigest,
  };
}
