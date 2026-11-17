import { createHash } from 'node:crypto';
import { z } from 'zod';
import { classifyGodotOutput } from '../../../../verification/godot-adapter.ts';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';
import { parseJunitXml } from './junit-adapter.js';

/**
 * Reusable, versioned Godot verification provider (#662) for any Godot repository. It packages what the existing adapters do
 * (headless import/parse/startup, GdUnit with JUnit, GDScript warnings and errors, `res://` reference validation) behind one manifest with
 * capabilities, engine and GdUnit compatibility, a required worker profile, optional asset mounts and an environment hash.
 *
 * Project-owned things stay in the project: suites, scenarios, exclusions, thresholds, assets and licences arrive as `GodotProjectConfig`.
 * Nothing here names a project, a path or hardware. Environment and infrastructure problems (wrong engine, missing display, missing
 * required asset mount, timeout, crash) are errors with their own reasons: they are never findings and never code regressions.
 */

export const GODOT_PROVIDER_ID = 'godot-verification';
export const GODOT_PROVIDER_VERSION = '1.0.0';

const versionRange = z.object({ min: z.string().regex(/^\d+\.\d+(\.\d+)?$/), max: z.string().regex(/^\d+\.\d+(\.\d+)?$/).optional() }).strict();
export const godotProviderManifestSchema = z.object({
  id: z.literal(GODOT_PROVIDER_ID),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  capabilities: z.array(z.enum(['parse', 'startup', 'gdunit', 'resource-references'])).min(1),
  engine: versionRange,
  gdunit: versionRange.optional(),
  /** What the worker must offer. `none` renderer and `headless` display run anywhere. */
  requires: z.object({ renderer: z.enum(['none', 'opengl', 'vulkan']), display: z.enum(['headless', 'x11', 'wayland']) }).strict(),
  assetMounts: z.array(z.object({ name: z.string().min(1).max(64), required: z.boolean() }).strict()).default([]),
}).strict();
export type GodotProviderManifest = z.infer<typeof godotProviderManifestSchema>;

export const DEFAULT_MANIFEST: GodotProviderManifest = godotProviderManifestSchema.parse({
  id: GODOT_PROVIDER_ID, version: GODOT_PROVIDER_VERSION, capabilities: ['parse', 'startup', 'gdunit', 'resource-references'],
  engine: { min: '4.2', max: '4.9' }, gdunit: { min: '4.0' }, requires: { renderer: 'none', display: 'headless' },
});

/** A project's own configuration, kept in its repository. */
export const godotProjectConfigSchema = z.object({
  projectDir: z.string().min(1).max(512),
  /** Test suites (GdUnit directories or scripts) owned by the project. */
  suites: z.array(z.string().min(1).max(512)).max(100).default([]),
  /** Paths or globs excluded from checks, with the project's reasons. */
  exclusions: z.array(z.string().min(1).max(512)).max(100).default([]),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  /** Asset mounts the project actually supplies on this worker, by manifest name. */
  mountsPresent: z.array(z.string().min(1).max(64)).max(32).default([]),
}).strict();
export type GodotProjectConfig = z.infer<typeof godotProjectConfigSchema>;

// ---- compatibility and environment --------------------------------------------------------------------------------------------
export interface WorkerCapabilities { engineVersion: string | undefined; gdunitVersion?: string | undefined; renderer: 'none' | 'opengl' | 'vulkan'; display: 'headless' | 'x11' | 'wayland'; os: string }

const cmp = (a: string, b: string) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d !== 0) return d; } return 0; };
const inRange = (v: string, r: { min: string; max?: string | undefined }) => cmp(v, r.min) >= 0 && (r.max === undefined || cmp(v, r.max) <= 0);

export class GodotEnvironmentError extends Error {
  constructor(readonly reason: 'engine-missing' | 'engine-incompatible' | 'gdunit-incompatible' | 'display-unavailable' | 'renderer-unavailable' | 'missing-asset-mount' | 'timeout' | 'crash', message: string) {
    super(message);
    this.name = 'GodotEnvironmentError';
  }
}

/** Capability matching: is this worker able to run this provider version for this project? Returns the problems, never throws. */
export function matchWorker(manifest: GodotProviderManifest, worker: WorkerCapabilities, project: GodotProjectConfig): GodotEnvironmentError[] {
  const out: GodotEnvironmentError[] = [];
  if (!worker.engineVersion) out.push(new GodotEnvironmentError('engine-missing', 'no Godot engine is available on this worker'));
  else if (!inRange(worker.engineVersion, manifest.engine)) out.push(new GodotEnvironmentError('engine-incompatible', `Godot ${worker.engineVersion} is outside the supported range ${manifest.engine.min}-${manifest.engine.max ?? 'any'}`));
  if (manifest.gdunit && project.suites.length > 0) {
    if (!worker.gdunitVersion || !inRange(worker.gdunitVersion, manifest.gdunit)) out.push(new GodotEnvironmentError('gdunit-incompatible', `GdUnit ${worker.gdunitVersion ?? 'missing'} does not satisfy >= ${manifest.gdunit.min}`));
  }
  const rank = { none: 0, opengl: 1, vulkan: 2 } as const;
  if (rank[worker.renderer] < rank[manifest.requires.renderer]) out.push(new GodotEnvironmentError('renderer-unavailable', `a ${manifest.requires.renderer} renderer is required`));
  if (manifest.requires.display !== 'headless' && worker.display !== manifest.requires.display) out.push(new GodotEnvironmentError('display-unavailable', `a ${manifest.requires.display} display is required`));
  for (const mount of manifest.assetMounts.filter((m) => m.required)) {
    if (!project.mountsPresent.includes(mount.name)) out.push(new GodotEnvironmentError('missing-asset-mount', `required asset mount ${mount.name} is not present: an environment problem, not a code regression`));
  }
  return out;
}

/** Hash of everything that can change a result without the code changing; part of the cache key and provenance. */
export function environmentHash(manifest: GodotProviderManifest, worker: WorkerCapabilities, project: GodotProjectConfig): string {
  const body = { provider: manifest.version, engine: worker.engineVersion ?? null, gdunit: worker.gdunitVersion ?? null, os: worker.os, renderer: worker.renderer, display: worker.display, mounts: [...project.mountsPresent].sort(), suites: [...project.suites].sort(), exclusions: [...project.exclusions].sort() };
  return `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

// ---- normalization ------------------------------------------------------------------------------------------------------------
const redactLine = (s: string) => s.replace(/(?:[A-Za-z]:)?[\\/](?:[\w.-]+[\\/])+[\w.-]+/g, '<path>').slice(0, 300);
/** A warning's identity ignores line numbers and paths, so known warning debt keeps one fingerprint while a new error gets its own. */
const warnId = (msg: string) => `godot.warning:${msg.toLowerCase().replace(/\(?\bline\s*\d+\)?/g, '').replace(/:\d+\b/g, '').replace(/[^a-z0-9_]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)}`;

export interface GodotFinding { id: string; severity: 'high' | 'low'; title: string; path?: string | undefined; line?: number | undefined }

export function normalizeGodotOutput(output: string): { findings: GodotFinding[]; editorNoise: number } {
  const { parse, warnings, editor } = classifyGodotOutput(output);
  return {
    editorNoise: editor.length,
    findings: [
      ...parse.map((d): GodotFinding => ({ id: `godot.parse-error:${d.file ?? 'unknown'}`, severity: 'high', title: redactLine(d.message), path: d.file, line: d.line })),
      ...warnings.map((d): GodotFinding => ({ id: warnId(d.message), severity: 'low', title: redactLine(d.message) })),
    ],
  };
}

export function normalizeJunit(xml: string): GodotFinding[] {
  const { cases } = parseJunitXml(xml);
  return cases.map((c) => ({ id: `godot.test-failure:${c.classname}.${c.name}`, severity: 'high' as const, title: redactLine(c.message ?? `${c.kind}: ${c.name}`), path: c.classname || undefined }));
}

/** Scene and resource reference validation: `res://` references in .tscn and .tres files that point at nothing. */
export function validateResourceRefs(files: ReadonlyArray<{ path: string; text: string }>, exists: (resPath: string) => boolean): GodotFinding[] {
  const out: GodotFinding[] = [];
  for (const f of files) {
    if (!/\.(tscn|tres)$/i.test(f.path)) continue;
    f.text.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(/path="res:\/\/([^"]+)"/g)) {
        if (!exists(m[1]!)) out.push({ id: `godot.missing-resource:${m[1]}`, severity: 'low', title: `${f.path} references res://${m[1]}, which does not exist`, path: f.path, line: i + 1 });
      }
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || (a.path ?? '').localeCompare(b.path ?? ''));
}

// ---- argv builders (generic, no project paths) --------------------------------------------------------------------------------
export function buildImportArgv(project: GodotProjectConfig): string[] { return ['godot', '--headless', '--path', project.projectDir, '--import', '--quit']; }
export function buildGdUnitArgv(project: GodotProjectConfig, suite: string): string[] {
  return ['godot', '--headless', '--path', project.projectDir, '-s', 'res://addons/gdUnit4/bin/GdUnitCmdTool.gd', '-a', suite, '--ignoreHeadlessMode'];
}

export interface GodotExecResult { exitCode: number; output: string; junitXml?: string | undefined; timedOut?: boolean | undefined }
export interface GodotProviderOptions {
  manifest?: GodotProviderManifest;
  project: GodotProjectConfig;
  worker: () => Promise<WorkerCapabilities>;
  exec: (argv: string[], signal: AbortSignal) => Promise<GodotExecResult>;
  readResources?: () => Promise<{ files: ReadonlyArray<{ path: string; text: string }>; exists: (resPath: string) => boolean } | undefined>;
}

export const GDUNIT_FAILURES = 100;
export const GDUNIT_WARNINGS = 101;

export function godotProvider(opts: GodotProviderOptions): CheckProviderPlugin {
  const manifest = opts.manifest ?? DEFAULT_MANIFEST;
  return {
    async run({ signal }): Promise<PluginRunOutput> {
      const worker = await opts.worker();
      const problems = matchWorker(manifest, worker, opts.project);
      if (problems.length > 0) throw problems[0]!;      // environment first: nothing below says anything about the code
      const envHash = environmentHash(manifest, worker, opts.project);
      const findings: GodotFinding[] = [];

      const imp = await opts.exec(buildImportArgv(opts.project), signal);
      if (imp.timedOut) throw new GodotEnvironmentError('timeout', 'the headless import timed out');
      const norm = normalizeGodotOutput(imp.output);
      if (norm.editorNoise > 0 && norm.findings.every((f) => f.severity === 'low') && imp.exitCode !== 0) throw new GodotEnvironmentError('crash', 'Godot could not open the project (editor or start-up failure)');
      findings.push(...norm.findings);

      for (const suite of opts.project.suites) {
        const r = await opts.exec(buildGdUnitArgv(opts.project, suite), signal);
        if (r.timedOut) throw new GodotEnvironmentError('timeout', `suite ${suite} timed out`);
        const out = normalizeGodotOutput(r.output);
        if (r.junitXml) findings.push(...normalizeJunit(r.junitXml), ...out.findings.filter((f) => f.severity === 'low'));
        else if (r.exitCode === GDUNIT_FAILURES) throw new GodotEnvironmentError('crash', `suite ${suite} reported failures but wrote no JUnit report`);
        else if (r.exitCode !== 0 && r.exitCode !== GDUNIT_WARNINGS) throw new GodotEnvironmentError('crash', `suite ${suite} exited with code ${r.exitCode} and no report`);
        else findings.push(...out.findings);
      }

      const res = await opts.readResources?.();
      if (res) findings.push(...validateResourceRefs(res.files, res.exists));
      const unique = [...new Map(findings.map((f) => [`${f.id}\u0000${f.path ?? ''}`, f])).values()];
      return {
        format: 'json', noFeed: true, inputsDigest: envHash,
        document: { findings: unique.map((f) => ({ id: f.id, severity: f.severity, title: f.title, path: f.path, line: f.line })) },
      };
    },
  };
}
