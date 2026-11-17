import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Documentation reference validation and architecture-decision drift check provider (#672). It adds no documentation engine:
 *
 * - broken references are checked only in the docs a change touched (links, anchors and backticked repository paths), with file and
 *   symbol existence answered by injected lookups;
 * - decision drift is exposed from the existing drift results (the decision lifecycle and drift detection own the judgement): each drifted
 *   decision becomes a finding carrying the decision id and its evidence as provenance.
 *
 * Findings are `custom` (quality debt), so existing breakage can be baselined and stays visible without blocking unrelated work, and a new
 * one blocks only where the finding policy says so.
 */

export interface DocFile { path: string; text: string }
export interface DocLookups {
  fileExists: (repoPath: string) => boolean;
  /** `path#Symbol` references; absent lookup means symbol references are not checked. */
  symbolExists?: (repoPath: string, symbol: string) => boolean;
}
export interface DocFinding { id: string; severity: 'medium' | 'low' | 'info'; title: string; path: string; line: number }

const norm = (p: string) => p.replace(/\\/g, '/');
const dirOf = (p: string) => (norm(p).includes('/') ? norm(p).slice(0, norm(p).lastIndexOf('/')) : '');

/** Resolve `target` relative to `docPath`'s directory, collapsing `.` and `..`. Returns undefined if it escapes the repository. */
export function resolveRelative(docPath: string, target: string): string | undefined {
  const parts = [...(dirOf(docPath) ? dirOf(docPath).split('/') : []), ...norm(target).split('/')];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length === 0) return undefined; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

/** GitHub-style heading slug. */
export const slug = (heading: string): string => heading.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

function headings(text: string): Set<string> {
  const out = new Set<string>(); let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    const m = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.add(slug(m[1]!));
  }
  return out;
}

const LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const CODE_PATH = /`((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6})(?:#([A-Za-z_][A-Za-z0-9_.]*))?`/g;

/** Broken references in one doc: relative links, in-page and cross-file anchors, backticked repo paths and `path#Symbol`. */
export function checkDocReferences(doc: DocFile, lookups: DocLookups, readDoc: (repoPath: string) => string | undefined = () => undefined): DocFinding[] {
  const out: DocFinding[] = [];
  const own = headings(doc.text);
  let fenced = false;
  doc.text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const lineNo = i + 1;
    for (const m of line.matchAll(LINK)) {
      const target = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;       // external URLs
      const [pathPart = '', anchor] = target.split('#') as [string, string | undefined];
      if (pathPart === '') {
        if (anchor && !own.has(anchor.toLowerCase())) out.push({ id: `docs.broken-anchor:${anchor}`, severity: 'low', title: `link to #${anchor} has no matching heading in this document`, path: doc.path, line: lineNo });
        continue;
      }
      const resolved = resolveRelative(doc.path, decodeURIComponent(pathPart));
      if (resolved === undefined || !lookups.fileExists(resolved)) {
        out.push({ id: `docs.broken-link:${resolved ?? pathPart}`, severity: 'medium', title: `link target ${pathPart} does not exist`, path: doc.path, line: lineNo });
      } else if (anchor && /\.md$/i.test(resolved)) {
        const text = readDoc(resolved);
        if (text !== undefined && !headings(text).has(anchor.toLowerCase())) out.push({ id: `docs.broken-anchor:${resolved}#${anchor}`, severity: 'low', title: `${resolved} has no heading for #${anchor}`, path: doc.path, line: lineNo });
      }
    }
    for (const m of line.matchAll(CODE_PATH)) {
      const file = m[1]!; const symbol = m[2];
      if (!lookups.fileExists(file)) out.push({ id: `docs.missing-path:${file}`, severity: 'medium', title: `referenced path ${file} does not exist`, path: doc.path, line: lineNo });
      else if (symbol && lookups.symbolExists && !lookups.symbolExists(file, symbol)) out.push({ id: `docs.missing-symbol:${file}#${symbol}`, severity: 'medium', title: `${file} has no symbol ${symbol}`, path: doc.path, line: lineNo });
    }
  });
  return out;
}

/** An existing drift result from the decision lifecycle and drift detection. This module only exposes it. */
export interface DriftResult {
  decisionId: string;
  state: 'in-sync' | 'drifted' | 'unknown';
  summary: string;
  /** Evidence references (commits, files, run ids) kept as provenance. */
  evidence: readonly string[];
  files: readonly string[];
}

export function driftFindings(results: readonly DriftResult[]): DocFinding[] {
  return results.filter((r) => r.state !== 'in-sync').map((r): DocFinding => ({
    id: `docs.decision-${r.state === 'drifted' ? 'drift' : 'unverified'}:${r.decisionId}`,
    severity: r.state === 'drifted' ? 'medium' : 'info',
    title: `${r.state === 'drifted' ? 'decision drift' : 'decision could not be verified'} for ${r.decisionId}: ${r.summary} [evidence: ${r.evidence.slice(0, 5).join(', ') || 'none'}]`,
    path: r.files[0] ?? `decision:${r.decisionId}`, line: 1,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

export interface DocDriftPluginOptions {
  /** Docs changed by this change; unchanged docs are never examined, so existing breakage elsewhere cannot block unrelated work. */
  changedDocs: () => Promise<readonly DocFile[]>;
  lookups: DocLookups;
  readDoc?: (repoPath: string) => string | undefined;
  readDrift?: () => Promise<readonly DriftResult[]>;
}

export function docDriftPlugin(opts: DocDriftPluginOptions): CheckProviderPlugin {
  return {
    async run(): Promise<PluginRunOutput> {
      const docs = (await opts.changedDocs()).filter((d) => /\.(md|mdx)$/i.test(d.path));
      const drift = opts.readDrift ? await opts.readDrift() : [];
      if (docs.length === 0 && drift.length === 0) return { format: 'json', document: { findings: [] }, notApplicable: 'no documentation changed and no decision drift results', noFeed: true };
      const findings = [...docs.flatMap((d) => checkDocReferences(d, opts.lookups, opts.readDoc)), ...driftFindings(drift)];
      return { format: 'json', document: { findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, path: f.path, line: f.line })) }, noFeed: true };
    },
  };
}
