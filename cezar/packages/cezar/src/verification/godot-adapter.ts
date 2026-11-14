import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { VerificationCheckRun } from '@open-mercato/cezar-contract';
import type { VerificationAdapter, VerificationAdapterContext } from './executor.ts';

/**
 * Wraps existing Godot project scripts (parse/resource validation, startup checks, GdUnit)
 * without changing them. The check command is run as declared in the manifest; this adapter
 * only classifies its output and ingests the JUnit XML the GdUnit runner already writes.
 * Check kind is chosen from the check id: `*parse*`/`*resource*`, `*startup*`, `*gdunit*`/`*unit*`.
 */
export type GodotCheckKind = 'parse' | 'startup' | 'gdunit' | 'other';
type Run = { status: VerificationCheckRun['status']; code: number | null; output: string; truncated: boolean; durationMs: number };
type Diagnostic = VerificationCheckRun['diagnostics'][number];
type Artifact = VerificationCheckRun['artifacts'][number];

export interface GodotAdapterOptions {
  /** Directories (relative to the check cwd) searched for JUnit XML. Defaults to `reports`. */
  junitDirs?: string[];
}

/** GdUnit4 exit codes: 100 = test failures, 101 = passed with warnings. */
export const GDUNIT_EXIT_FAILURES = 100;
export const GDUNIT_EXIT_WARNINGS = 101;

export function godotCheckKind(checkId: string): GodotCheckKind {
  const id = checkId.toLowerCase();
  if (/gdunit|unit/.test(id)) return 'gdunit';
  if (/startup|launch|boot/.test(id)) return 'startup';
  if (/parse|resource|import|lint/.test(id)) return 'parse';
  return 'other';
}

const cap = (text: string) => text.slice(0, 1_900);
const relPath = (path: string) => path.replace(/^res:\/\//, '').replaceAll('\\', '/');
const validRel = (path: string) => path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && path.split('/').every((p) => p && p !== '.' && p !== '..');

/** Separate script parse errors (project defects) from editor/startup noise (environment). */
export function classifyGodotOutput(output: string): { parse: Diagnostic[]; editor: Diagnostic[]; warnings: Diagnostic[] } {
  const parse: Diagnostic[] = [];
  const editor: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length && parse.length + editor.length + warnings.length < 150; i++) {
    const line = lines[i]!;
    const parseMatch = /SCRIPT ERROR:\s*Parse Error:\s*(.*)/.exec(line);
    if (parseMatch || /Failed to load (script|resource)|Parse Error:/.test(line)) {
      const location = /\((res:\/\/[^:)]+):(\d+)\)/.exec(lines[i + 1] ?? '') ?? /(res:\/\/[^:\s]+):(\d+)/.exec(line);
      const file = location ? relPath(location[1]!) : undefined;
      parse.push({
        code: 'godot.parse-error', severity: 'error', message: cap(parseMatch?.[1] ?? line.trim()),
        ...(file && validRel(file) ? { file, line: Number(location![2]) } : {}),
      });
    } else if (/editor|Cannot (open|load) (file|project)|Couldn't (load|open) project|Unable to (start|initialize)|Failed to (start|initialize)|display driver|No such file or directory.*godot/i.test(line) && /ERROR|FATAL|Cannot|Couldn't|Unable|Failed/i.test(line)) {
      editor.push({ code: 'godot.editor-error', severity: 'error', message: cap(line.trim()) });
    } else if (/^WARNING:/.test(line)) {
      warnings.push({ code: 'godot.warning', severity: 'warning', message: cap(line.trim()) });
    }
  }
  return { parse, editor, warnings };
}

interface JunitSummary { tests: number; failures: number; errors: number; skipped: number; files: string[]; malformed: string[] }

function attr(tag: string, name: string): number {
  const m = new RegExp(`\\b${name}="(\\d+)"`).exec(tag);
  return m ? Number(m[1]) : 0;
}

export function parseJunit(xml: string): { tests: number; failures: number; errors: number; skipped: number } | undefined {
  if (!/<testsuites?\b/.test(xml) || !/<\/testsuites?>|<testsuites?\b[^>]*\/>/.test(xml)) return undefined;
  const root = /<testsuites\b[^>]*>/.exec(xml);
  const suites = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map((m) => m[0]);
  if (root && /\btests="\d+"/.test(root[0]) && suites.length === 0) {
    return { tests: attr(root[0], 'tests'), failures: attr(root[0], 'failures'), errors: attr(root[0], 'errors'), skipped: attr(root[0], 'skipped') };
  }
  if (suites.length === 0) return undefined;
  // Count suites directly so nested/duplicated aggregate attributes are not double counted.
  const cases = [...xml.matchAll(/<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g)].map((m) => m[0]);
  if (cases.length > 0) {
    return {
      tests: cases.length,
      failures: cases.filter((c) => /<failure\b/.test(c)).length,
      errors: cases.filter((c) => /<error\b/.test(c)).length,
      skipped: cases.filter((c) => /<skipped\b/.test(c)).length,
    };
  }
  return suites.reduce((acc, s) => ({ tests: acc.tests + attr(s, 'tests'), failures: acc.failures + attr(s, 'failures'), errors: acc.errors + attr(s, 'errors'), skipped: acc.skipped + attr(s, 'skipped') }), { tests: 0, failures: 0, errors: 0, skipped: 0 });
}

async function findXml(base: string, since: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.xml') && (await stat(full)).mtimeMs >= since - 1_000) found.push(full);
    }
  };
  await walk(base, 0);
  return found.sort().slice(0, 50);
}

async function ingestJunit(context: VerificationAdapterContext, dirs: string[], since: number): Promise<JunitSummary & { artifacts: Artifact[] }> {
  const total: JunitSummary & { artifacts: Artifact[] } = { tests: 0, failures: 0, errors: 0, skipped: 0, files: [], malformed: [], artifacts: [] };
  for (const dir of dirs) {
    const base = await realpath(join(context.cwd, dir)).catch(() => undefined);
    if (!base) continue;
    for (const file of await findXml(base, since)) {
      const real = await realpath(file);
      const rel = relative(context.root, real).split(sep).join('/');
      if (rel.startsWith('..') || !validRel(rel)) continue;
      const bytes = await readFile(real);
      const parsed = parseJunit(bytes.toString('utf8'));
      total.files.push(rel);
      total.artifacts.push({ path: rel, mediaType: 'application/xml', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      if (!parsed) { total.malformed.push(rel); continue; }
      total.tests += parsed.tests; total.failures += parsed.failures; total.errors += parsed.errors; total.skipped += parsed.skipped;
    }
  }
  return total;
}

export function createGodotVerificationAdapter(options: GodotAdapterOptions = {}): VerificationAdapter {
  const dirs = options.junitDirs ?? ['reports'];
  const evidence = new Map<string, { diagnostics: Diagnostic[]; artifacts: Artifact[]; note?: string }>();
  const key = (context: VerificationAdapterContext) => `${context.root}\0${context.checkId}`;

  return {
    async execute(context, runCommand) {
      const kind = godotCheckKind(context.checkId);
      const since = Date.now();
      const result: Run = await runCommand();
      const diagnostics: Diagnostic[] = [];
      let artifacts: Artifact[] = [];
      let { status } = result;
      let note: string | undefined;
      if (status === 'cancelled' || result.code === null || result.truncated) {
        evidence.set(key(context), { diagnostics, artifacts });
        return result;
      }
      const classified = classifyGodotOutput(result.output);
      diagnostics.push(...classified.warnings);
      if (kind === 'gdunit') {
        const junit = await ingestJunit(context, dirs, since);
        artifacts = junit.artifacts;
        const code = result.code;
        if (junit.malformed.length > 0) {
          status = 'unknown'; note = `malformed JUnit XML: ${junit.malformed.join(', ')}`;
        } else if (code === GDUNIT_EXIT_FAILURES || junit.failures + junit.errors > 0) {
          status = 'failed'; note = `${junit.failures + junit.errors} failing test(s)`;
        } else if (code === GDUNIT_EXIT_WARNINGS || (code === 0 && classified.warnings.length > 0)) {
          // Warning semantics preserved: warnings are reported but do not fail the check.
          status = junit.tests === 0 && junit.files.length === 0 ? 'unknown' : 'passed';
          diagnostics.push({ code: 'gdunit.warnings', severity: 'warning', message: 'GdUnit finished with warnings' });
        } else if (code !== 0) {
          status = 'infrastructure-error';
        } else if (junit.files.length === 0) {
          status = 'unknown'; note = 'GdUnit exited 0 but wrote no JUnit XML';
        } else if (junit.tests === 0) {
          status = 'no-tests';
        } else if (junit.skipped >= junit.tests) {
          status = 'skipped';
        } else {
          status = 'passed';
        }
        for (const file of junit.malformed) diagnostics.push({ code: 'gdunit.malformed-xml', severity: 'error', message: 'JUnit XML could not be parsed', ...(validRel(file) ? { file } : {}) });
        if (junit.skipped > 0) diagnostics.push({ code: 'gdunit.skipped', severity: 'info', message: `${junit.skipped} of ${junit.tests} test(s) skipped` });
      } else {
        const hasParse = classified.parse.length > 0;
        diagnostics.push(...classified.parse.map((d) => (kind === 'startup' ? { ...d, code: 'godot.startup-error' } : d)));
        if (hasParse && status !== 'failed') { status = 'failed'; note = `${classified.parse.length} script parse error(s) despite exit ${result.code}`; }
        if (classified.editor.length > 0) {
          // Editor/startup trouble is environmental: never masked as a script defect, never a pass.
          diagnostics.push(...classified.editor);
          if (!hasParse && status === 'passed') { status = 'infrastructure-error'; note = 'editor/startup errors reported'; }
        }
      }
      evidence.set(key(context), { diagnostics: diagnostics.slice(0, 200), artifacts, ...(note ? { note } : {}) });
      return { ...result, status, output: note ? `${result.output}\n[godot-adapter] ${note}` : result.output };
    },
    async collect(context, check) {
      const found = evidence.get(key(context));
      evidence.delete(key(context));
      if (!found) return check;
      return { ...check, diagnostics: found.diagnostics, artifacts: found.artifacts };
    },
    async cleanup(context) { evidence.delete(key(context)); },
  };
}
