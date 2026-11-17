import { createHash } from 'node:crypto';
import { normalizeFindingMessage } from './fingerprint.ts';

/**
 * Project-agnostic Godot verification provider (#662). The manifest is versioned data
 * (schemas/godot-provider-manifest.schema.json); project-owned suites, assets, thresholds and
 * known-debt baselines stay in the project repository and are passed in as `GodotProviderContext`.
 */
export const GODOT_PROVIDER_MANIFEST_VERSION = 1;
export type GodotCapability = 'parse' | 'startup' | 'gdunit' | 'scene-resource-refs' | 'render' | 'network-scenario' | 'gua';
export interface GodotVersionRange { min?: string; max?: string }
export interface GodotProviderManifest {
  version: 1;
  provider: { name: string; version: string; digest?: string };
  capabilities: GodotCapability[];
  compatibility: { engine: GodotVersionRange; gdunit?: GodotVersionRange };
  install: { discovery: string[]; installer?: string };
  provenance: { tools: { name: string; version: string; source?: string; sha256?: string }[] };
  workerProfile: { renderer: 'none' | 'software' | 'gpu'; display: 'headless' | 'virtual' | 'physical'; os?: string[]; capabilities?: string[] };
  assetMounts?: { name: string; optional?: boolean }[];
  environmentHash: string;
}

/** What the worker actually offers; supplied by the capability probes, never by the provider. */
export interface GodotEnvironment {
  os?: string;
  engineVersion?: string;
  gdunitVersion?: string;
  renderer?: 'none' | 'software' | 'gpu';
  display?: 'headless' | 'virtual' | 'physical';
  mountedAssets?: string[];
  capabilities?: string[];
}

export interface GodotProviderContext {
  manifest: GodotProviderManifest;
  environment: GodotEnvironment;
  /** Project-owned fingerprints of accepted warning debt. */
  knownWarningFingerprints?: readonly string[];
  /** Project-owned fingerprints of accepted (baselined) errors. */
  knownErrorFingerprints?: readonly string[];
}

export interface GodotInfraProblem { code: string; message: string }

const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CAPS = new Set<string>(['parse', 'startup', 'gdunit', 'scene-resource-refs', 'render', 'network-scenario', 'gua']);
const VERSION = /^\d+(\.\d+){0,2}$/;

export function validateGodotProviderManifest(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const m = value as Partial<GodotProviderManifest> | null;
  if (!m || typeof m !== 'object') return { valid: false, errors: ['manifest must be an object'] };
  if (m.version !== 1) errors.push('version must be 1');
  if (!m.provider || !NAME.test(m.provider.name ?? '') || !m.provider.version) errors.push('provider.name/version required');
  if (m.provider?.digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(m.provider.digest)) errors.push('provider.digest must be sha256:<hex>');
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0 || m.capabilities.some((c) => !CAPS.has(c)) || new Set(m.capabilities).size !== m.capabilities.length) errors.push('capabilities must be a unique non-empty list of known capabilities');
  for (const [k, r] of [['engine', m.compatibility?.engine], ['gdunit', m.compatibility?.gdunit]] as const) {
    if (k === 'engine' && !r) errors.push('compatibility.engine required');
    if (r && ((r.min !== undefined && !VERSION.test(r.min)) || (r.max !== undefined && !VERSION.test(r.max)))) errors.push(`compatibility.${k} range invalid`);
  }
  if (!Array.isArray(m.install?.discovery) || m.install.discovery.length === 0) errors.push('install.discovery required');
  if (!Array.isArray(m.provenance?.tools) || m.provenance.tools.length === 0 || m.provenance.tools.some((t) => !t.name || !t.version)) errors.push('provenance.tools requires name/version');
  if (!m.workerProfile || !['none', 'software', 'gpu'].includes(m.workerProfile.renderer) || !['headless', 'virtual', 'physical'].includes(m.workerProfile.display)) errors.push('workerProfile.renderer/display invalid');
  if (!/^sha256:[0-9a-f]{64}$/.test(m.environmentHash ?? '')) errors.push('environmentHash must be sha256:<hex>');
  return { valid: errors.length === 0, errors };
}

/** Deterministic hash over what makes two Godot environments interchangeable for a result. */
export function godotEnvironmentHash(env: GodotEnvironment): string {
  const canonical = JSON.stringify([env.os ?? '', env.engineVersion ?? '', env.gdunitVersion ?? '', env.renderer ?? '', env.display ?? '']);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function cmp(a: string, b: string): number {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}
const parseVersion = (v: string | undefined) => /(\d+(?:\.\d+){0,2})/.exec(v ?? '')?.[1];
const inRange = (v: string, r: GodotVersionRange) => (!r.min || cmp(v, r.min) >= 0) && (!r.max || cmp(v, r.max) <= 0);

/** Environment problems are never code regressions: they map to infrastructure outcomes. */
export function checkGodotEnvironment(manifest: GodotProviderManifest, env: GodotEnvironment): GodotInfraProblem[] {
  const problems: GodotInfraProblem[] = [];
  const engine = parseVersion(env.engineVersion);
  if (!engine) problems.push({ code: 'godot.engine-missing', message: 'Godot engine version could not be discovered' });
  else if (!inRange(engine, manifest.compatibility.engine)) problems.push({ code: 'godot.engine-mismatch', message: `Godot ${engine} is outside the provider-supported range ${JSON.stringify(manifest.compatibility.engine)}` });
  if (manifest.compatibility.gdunit && manifest.capabilities.includes('gdunit')) {
    const g = parseVersion(env.gdunitVersion);
    if (!g) problems.push({ code: 'godot.gdunit-missing', message: 'GdUnit version could not be discovered' });
    else if (!inRange(g, manifest.compatibility.gdunit)) problems.push({ code: 'godot.gdunit-mismatch', message: `GdUnit ${g} is outside the provider-supported range ${JSON.stringify(manifest.compatibility.gdunit)}` });
  }
  const wp = manifest.workerProfile;
  if (wp.os && env.os && !wp.os.includes(env.os)) problems.push({ code: 'godot.os-mismatch', message: `worker os ${env.os} not in ${wp.os.join(',')}` });
  const rank = { none: 0, software: 1, gpu: 2 } as const;
  if (env.renderer !== undefined && rank[env.renderer] < rank[wp.renderer]) problems.push({ code: 'godot.renderer-mismatch', message: `provider needs renderer ${wp.renderer}, worker has ${env.renderer}` });
  if (wp.display !== 'headless' && env.display !== undefined && env.display !== wp.display && !(wp.display === 'virtual' && env.display === 'physical')) problems.push({ code: 'godot.display-mismatch', message: `provider needs display ${wp.display}, worker has ${env.display}` });
  for (const cap of wp.capabilities ?? []) if (env.capabilities && !env.capabilities.includes(cap)) problems.push({ code: 'godot.worker-capability-missing', message: `worker lacks capability ${cap}` });
  for (const mount of manifest.assetMounts ?? []) if (!mount.optional && !(env.mountedAssets ?? []).includes(mount.name)) problems.push({ code: 'godot.asset-mount-missing', message: `required asset mount "${mount.name}" is not available` });
  return problems;
}

/** Capability-matching predicate for #213 workers: all provider requirements must be offered. */
export function godotWorkerMatches(manifest: GodotProviderManifest, env: GodotEnvironment): boolean {
  return checkGodotEnvironment(manifest, env).length === 0;
}

/** Fingerprint with location, numbers and paths removed so debt survives line moves. */
export function godotDiagnosticFingerprint(kind: 'warning' | 'error', message: string): string {
  return createHash('sha256').update(`godot.${kind}\0${normalizeFindingMessage(message)}`).digest('hex');
}

const SECRET = [
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{12,}/gi,
  /\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[=:]\s*)\S+/gi,
];
/** Redacted, bounded excerpt for display; the raw log is kept separately as the source artifact. */
export function redactExcerpt(text: string, max = 1_900): string {
  let out = text;
  out = out.replace(SECRET[0]!, '[redacted]').replace(SECRET[1]!, '[redacted]').replace(SECRET[2]!, '$1 [redacted]').replace(SECRET[3]!, '$1$2[redacted]');
  out = out.replace(/\/(?:home|Users)\/[^/\s]+/g, '/~').replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, 'C:\\~');
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Engine crash signatures (any OS) and POSIX/Windows crash exit codes. */
export function detectGodotCrash(output: string, code: number | null): boolean {
  if (/handle_crash|Program crashed with signal|Segmentation fault|Access violation|STATUS_ACCESS_VIOLATION/i.test(output)) return true;
  return code !== null && [134, 139, 3221225477, -1073741819].includes(code);
}

/** Runtime errors (not parse errors) printed by the engine or GdUnit. */
export function extractRuntimeErrors(output: string): string[] {
  return output.split(/\r?\n/).filter((l) => /^(SCRIPT ERROR|ERROR):/.test(l) && !/Parse Error|Cannot (open|load)|Couldn't|Unable to|Failed to (start|init)/i.test(l)).slice(0, 100);
}
