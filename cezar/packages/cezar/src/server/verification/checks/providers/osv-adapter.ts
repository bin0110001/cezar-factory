import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * OSV-Scanner adapter (#607): the alternate software-composition provider behind the same contract and runner as
 * the Trivy adapter. Swapping providers is a definition change (`provider` identity and plugin); core release logic
 * is untouched. `exec` runs in the #605 isolated scanner worker; this module never spawns a process.
 */

export type OsvDomain = 'repository' | 'image';

export function buildOsvArgv(i: { domain: OsvDomain; target: string }): string[] {
  const argv = ['osv-scanner', 'scan', i.domain === 'image' ? 'image' : 'source'];
  if (i.domain === 'repository') argv.push('-r');
  argv.push('--format', 'json', '--', i.target);
  return argv;
}

export interface OsvExecResult { exitCode: number; stdout: string }
export type OsvExec = (argv: string[], signal: AbortSignal) => Promise<OsvExecResult>;

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function severityOf(vuln: J, groupMax: string | undefined): string {
  const named = s(o(vuln.database_specific).severity);
  if (named) return named;
  const score = Number.parseFloat(groupMax ?? '');
  if (Number.isNaN(score)) return 'unknown';
  return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
}

function fixedVersion(vuln: J, pkgName: string | undefined): string | undefined {
  for (const aff of a(vuln.affected).map(o)) {
    if (pkgName && s(o(aff.package).name) !== pkgName) continue;
    for (const range of a(aff.ranges).map(o)) for (const ev of a(range.events).map(o)) if (s(ev.fixed)) return s(ev.fixed);
  }
  return undefined;
}

export function osvToGenericFindings(report: unknown): { findings: J[]; applicable: boolean } {
  const doc = o(report);
  if (doc.results !== null && doc.results !== undefined && !Array.isArray(doc.results)) throw new Error('unexpected OSV report: results is not a list');
  const results = a(doc.results).map(o);
  const findings: J[] = [];
  for (const r of results) {
    const path = s(o(r.source).path);
    for (const p of a(r.packages).map(o)) {
      const pkg = o(p.package);
      const name = s(pkg.name);
      const groupMax = new Map(a(p.groups).map(o).flatMap((g) => a(g.ids).map((id) => [String(id), s(g.max_severity)] as const)));
      for (const v of a(p.vulnerabilities).map(o)) {
        const id = s(v.id) ?? 'unknown-vulnerability';
        findings.push({
          id, severity: severityOf(v, groupMax.get(id)), package: name, ecosystem: s(pkg.ecosystem)?.toLowerCase(), version: s(pkg.version),
          fixedVersion: fixedVersion(v, name),
          // Aliases carry the CVE/GHSA ids the shared fingerprint keys on.
          title: [s(v.summary), ...a(v.aliases).map(String)].filter(Boolean).join(' ') || id,
          path, references: a(v.references).map((x) => s(o(x).url)).filter(Boolean).slice(0, 10),
          fingerprint: `${id}|${name}|${s(pkg.version)}|${path}`,
        });
      }
    }
  }
  // A scanned source lists its packages even without vulnerabilities.
  return { findings, applicable: results.length > 0 };
}

export interface OsvPluginOptions {
  domain: OsvDomain;
  target: string;
  exec: OsvExec;
  readDbUpdatedAt: () => Promise<string | undefined>;
  observed?: () => Promise<NonNullable<PluginRunOutput['observed']>>;
}

/** Exit 0 = clean, 1 = vulnerabilities found (both usable); 128 = nothing to scan; anything else is an error. */
export function osvPlugin(opts: OsvPluginOptions): CheckProviderPlugin {
  return {
    probe: async () => ({ dbUpdatedAt: await opts.readDbUpdatedAt() }),
    async run({ signal }): Promise<PluginRunOutput> {
      const res = await opts.exec(buildOsvArgv({ domain: opts.domain, target: opts.target }), signal);
      const common = async () => ({ dbUpdatedAt: await opts.readDbUpdatedAt(), observed: await opts.observed?.() });
      if (res.exitCode === 128) return { format: 'json', document: { findings: [] }, notApplicable: 'no lockfile or scannable package source found', ...(await common()) };
      if (res.exitCode !== 0 && res.exitCode !== 1) throw new Error(`osv-scanner exited with code ${res.exitCode}`);
      let report: unknown;
      try { report = JSON.parse(res.stdout); } catch { throw new Error('osv-scanner produced non-JSON output'); }
      const { findings, applicable } = osvToGenericFindings(report);
      if (!applicable) return { format: 'json', document: { findings: [] }, notApplicable: 'no lockfile or scannable package source found', ...(await common()) };
      return { format: 'json', document: { findings }, ...(await common()) };
    },
  };
}
