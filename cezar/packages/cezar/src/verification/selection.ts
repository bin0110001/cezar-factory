import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { VerificationManifest } from '@open-mercato/cezar-contract';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 4_000_000;
const MAX_DEPENDENCY_FILE_BYTES = 2_000_000;
const MAX_DEPENDENCY_FILES = 20_000;
const MAX_CHANGED_PATHS = 5_000;

export type SelectionMode = 'all' | 'impacted' | 'last-failed' | 'component' | 'explicit';
export interface SelectionRequest {
  mode: SelectionMode;
  baseRef?: string;
  changedPaths?: string[];
  renamedPaths?: Array<{ from: string; to: string }>;
  checkIds?: string[];
  lastFailedCheckIds?: string[];
  componentTags?: string[];
}
export interface CheckSelection {
  checkId: string;
  status: 'selected' | 'deferred';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}
export interface VerificationSelection {
  version: 1;
  mode: SelectionMode;
  suite: string;
  baseSha?: string;
  changedPaths: string[];
  fallbackUsed: boolean;
  checks: CheckSelection[];
}
export interface SelectionResult { selectedIds: string[]; selection: VerificationSelection }

function norm(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function globRegex(pattern: string): RegExp | undefined {
  const value = norm(pattern);
  if (!value || /[\[\]{}]/.test(value)) return undefined;
  let result = '^';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '*' && value[i + 1] === '*') {
      i++;
      if (value[i + 1] === '/') { i++; result += '(?:.*/)?'; }
      else result += '.*';
    } else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${result}$`, process.platform === 'win32' ? 'i' : '');
}

function owns(check: VerificationManifest['checks'][string], path: string): boolean | undefined {
  if (!check.owns?.length) return false;
  let uncertain = false;
  for (const pattern of check.owns) {
    const regex = globRegex(pattern);
    if (!regex) { uncertain = true; continue; }
    if (regex.test(norm(path))) return true;
  }
  return uncertain ? undefined : false;
}

interface DependencyGraph { dependents: Map<string, Set<string>>; dynamicFiles: Set<string>; uncertain: boolean }

async function godotDependencies(root: string): Promise<DependencyGraph> {
  const graph: DependencyGraph = { dependents: new Map(), dynamicFiles: new Set(), uncertain: false };
  let files: string[];
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: MAX_DIFF_BYTES });
    files = stdout.split('\0').filter(Boolean).map(norm);
  } catch { graph.uncertain = true; return graph; }
  if (files.length > MAX_DEPENDENCY_FILES) { graph.uncertain = true; return graph; }
  for (const file of files) {
    if (!/\.(gd|tscn|tres|godot)$/i.test(file)) continue;
    let source: string;
    try {
      const path = join(root, file);
      const real = await realpath(path);
      const rel = relative(root, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { graph.uncertain = true; continue; }
      if ((await stat(real)).size > MAX_DEPENDENCY_FILE_BYTES) { graph.uncertain = true; continue; }
      source = await readFile(real, 'utf8');
    }
    catch { graph.uncertain = true; continue; }
    if (/\b(?:preload|load|ResourceLoader\.load)\s*\(\s*[^"'\s]/.test(source)) graph.dynamicFiles.add(file);
    const refs = new Set<string>();
    const regex = /res:\/\/([^"'\s)]+)/g;
    for (const match of source.matchAll(regex)) {
      const ref = norm(match[1] ?? '');
      if (ref && !ref.startsWith('../') && !isAbsolute(ref)) refs.add(ref);
    }
    for (const ref of refs) {
      graph.dependents.set(ref, graph.dependents.get(ref) ?? new Set());
      graph.dependents.get(ref)!.add(file);
    }
  }
  return graph;
}

function parseChanged(raw: string): { paths: string[]; renamed: Array<{ from: string; to: string }> } | undefined {
  const tokens = raw.split('\0');
  const paths: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = tokens[i++]; const to = tokens[i++];
      if (!from || !to) return undefined;
      renamed.push({ from: norm(from), to: norm(to) }); paths.push(norm(from), norm(to));
    } else {
      const path = tokens[i++];
      if (!path) return undefined;
      paths.push(norm(path));
    }
  }
  return { paths: [...new Set(paths)], renamed };
}

/** Collect safe merge-base changes; an invalid/unknown base produces an explicit uncertainty. */
export async function collectVerificationDiff(root: string, baseRef: string): Promise<{ baseSha?: string; changedPaths: string[]; renamedPaths: Array<{ from: string; to: string }>; uncertain: boolean }> {
  if (!baseRef || baseRef.startsWith('-') || !/^[A-Za-z0-9_./-]+$/.test(baseRef)) return { changedPaths: [], renamedPaths: [], uncertain: true };
  try {
    const { stdout: baseSha } = await execFileAsync('git', ['merge-base', baseRef, 'HEAD'], { cwd: root, maxBuffer: 32_000 });
    const base = baseSha.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(base)) return { changedPaths: [], renamedPaths: [], uncertain: true };
    const { stdout } = await execFileAsync('git', ['diff', '--name-status', '-z', '--find-renames', base, 'HEAD', '--'], { cwd: root, maxBuffer: MAX_DIFF_BYTES });
    const parsed = parseChanged(stdout);
    return parsed ? { baseSha: base, changedPaths: parsed.paths, renamedPaths: parsed.renamed, uncertain: false } : { baseSha: base, changedPaths: [], renamedPaths: [], uncertain: true };
  } catch { return { changedPaths: [], renamedPaths: [], uncertain: true }; }
}

export async function selectVerificationChecks(
  root: string,
  manifest: VerificationManifest,
  suite: string,
  request: SelectionRequest,
): Promise<SelectionResult> {
  const ids = manifest.suites[suite];
  if (!ids) throw new Error(`unknown verification suite: ${suite}`);
  let changedPaths = [...(request.changedPaths ?? [])].map(norm);
  let renamedPaths = request.renamedPaths ?? [];
  let baseSha: string | undefined;
  let uncertain = false;
  if (request.mode === 'impacted' && request.baseRef) {
    const diff = await collectVerificationDiff(root, request.baseRef);
    changedPaths = diff.changedPaths;
    renamedPaths = diff.renamedPaths;
    baseSha = diff.baseSha;
    uncertain = diff.uncertain;
  } else if (request.mode === 'impacted' && !changedPaths.length) uncertain = true;
  if (changedPaths.length > MAX_CHANGED_PATHS) { changedPaths = changedPaths.slice(0, MAX_CHANGED_PATHS); uncertain = true; }

  const selected = new Map<string, { confidence: CheckSelection['confidence']; reason: string }>();
  let fallbackUsed = uncertain;
  const select = (id: string, confidence: CheckSelection['confidence'], reason: string) => {
    if (!ids.includes(id)) return;
    const existing = selected.get(id);
    if (!existing || (existing.confidence === 'medium' && confidence === 'high')) selected.set(id, { confidence, reason });
  };

  if (request.mode === 'all') {
    for (const id of ids) select(id, 'high', 'full suite explicitly requested');
  } else if (request.mode === 'explicit') {
    const wanted = new Set(request.checkIds ?? []);
    const invalid = [...wanted].filter((id) => !ids.includes(id));
    if (invalid.length) throw new Error(`explicit checks are outside suite ${suite}: ${invalid.join(', ')}`);
    for (const id of wanted) select(id, 'high', 'explicitly selected');
  } else if (request.mode === 'component') {
    const tags = new Set(request.componentTags ?? []);
    if (!tags.size) throw new Error('component selection requires at least one component tag');
    for (const id of ids) {
      const matched = (manifest.checks[id]?.tags ?? []).filter((tag) => tags.has(tag));
      if (matched.length) select(id, 'high', `matches component tag${matched.length > 1 ? 's' : ''} ${matched.join(', ')}`);
    }
    if (!selected.size) throw new Error(`no checks in suite ${suite} match component tags ${[...tags].join(', ')}`);
  } else if (request.mode === 'last-failed') {
    for (const id of request.lastFailedCheckIds ?? []) select(id, 'high', 'open finding has failed in prior verification');
  } else if (!uncertain) {
    const graph = await godotDependencies(root);
    const changed = [...new Set([...changedPaths, ...renamedPaths.flatMap((item) => [norm(item.from), norm(item.to)])])];
    for (const path of changed) {
      let directOwner = false;
      for (const id of ids) {
        const match = owns(manifest.checks[id]!, path);
        if (match === undefined) uncertain = true;
        if (match) { directOwner = true; select(id, 'high', `owns changed path ${path}`); }
      }
      if (!directOwner && !/\.(md|txt|png|jpe?g|svg)$/i.test(path)) uncertain = true;
      if (graph.dynamicFiles.has(path)) uncertain = true;
      const queue = [path];
      const visitedResources = new Set<string>();
      while (queue.length) {
        const resource = queue.shift()!;
        if (visitedResources.has(resource)) continue;
        visitedResources.add(resource);
        for (const dependent of graph.dependents.get(resource) ?? []) {
          for (const id of ids) if (owns(manifest.checks[id]!, dependent)) select(id, 'medium', `depends on changed Godot resource ${path} through ${dependent}`);
          queue.push(dependent);
        }
      }
    }
    if (graph.uncertain) uncertain = true;
    // Manifest-declared edges expand the direct and resource matches transitively.
    let changedSet = new Set(selected.keys());
    for (let pass = 0; pass < ids.length; pass++) {
      let grew = false;
      for (const id of [...changedSet]) {
        for (const dependency of manifest.checks[id]?.dependsOn ?? []) {
          if (ids.includes(dependency) && !selected.has(dependency)) {
            select(dependency, 'medium', `declared dependency of ${id}`);
            changedSet.add(dependency); grew = true;
          }
        }
      }
      if (!grew) break;
    }
  }
  if (uncertain) {
    fallbackUsed = true;
    selected.clear();
    for (const id of ids) select(id, 'low', 'impact uncertain; expanded to the full suite');
  }
  const checks = ids.map((checkId): CheckSelection => {
    const reason = selected.get(checkId);
    return reason ? { checkId, status: 'selected', ...reason } : { checkId, status: 'deferred', confidence: 'high', reason: request.mode === 'last-failed' ? 'no open finding for this check' : request.mode === 'explicit' ? 'not in explicit selection' : 'no direct or declared impact found' };
  });
  return { selectedIds: checks.filter((item) => item.status === 'selected').map((item) => item.checkId), selection: { version: 1, mode: request.mode, suite, ...(baseSha ? { baseSha } : {}), changedPaths, fallbackUsed, checks } };
}
