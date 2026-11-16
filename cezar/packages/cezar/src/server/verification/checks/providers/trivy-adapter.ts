import type { CheckCategory } from '../check-provider.js';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Trivy adapter (#606) behind the check-provider contract. All scanner-specific knowledge (argv, JSON shape)
 * lives here; core release logic sees only normalized findings. `exec` runs the argv in the isolated scanner
 * worker profile (#605) and must supply a scrubbed environment; this module never spawns a process itself.
 */

export type TrivyDomain = 'repository' | 'filesystem' | 'image' | 'misconfiguration' | 'secret' | 'license';

export const TRIVY_DOMAINS: Readonly<Record<TrivyDomain, { category: CheckCategory; subcommand: string; scanners: string }>> = {
  repository: { category: 'sca', subcommand: 'fs', scanners: 'vuln' },
  filesystem: { category: 'sca', subcommand: 'rootfs', scanners: 'vuln' },
  image: { category: 'container', subcommand: 'image', scanners: 'vuln' },
  misconfiguration: { category: 'iac', subcommand: 'config', scanners: 'misconfig' },
  secret: { category: 'secrets', subcommand: 'fs', scanners: 'secret' },
  license: { category: 'license', subcommand: 'fs', scanners: 'license' },
};

export interface TrivyArgvInput { domain: TrivyDomain; target: string; sbom?: boolean }

export function buildTrivyArgv(i: TrivyArgvInput): string[] {
  const d = TRIVY_DOMAINS[i.domain];
  const argv = ['trivy', d.subcommand, '--quiet', '--format', i.sbom ? 'cyclonedx' : 'json'];
  if (d.subcommand !== 'config') argv.push('--scanners', d.scanners);
  argv.push('--', i.target);
  return argv;
}

export interface TrivyExecResult { exitCode: number; stdout: string }
export type TrivyExec = (argv: string[], signal: AbortSignal) => Promise<TrivyExecResult>;

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Convert Trivy JSON to the generic findings document. Secret `Match` text is deliberately never copied. */
export function trivyToGenericFindings(report: unknown): { findings: J[]; applicable: boolean } {
  const doc = o(report);
  if (!Array.isArray(doc.Results) && doc.Results !== null && doc.Results !== undefined) throw new Error('unexpected Trivy report: Results is not a list');
  const results = a(doc.Results).map(o);
  const findings: J[] = [];
  for (const r of results) {
    const target = s(r.Target);
    const ecosystem = s(r.Type);
    for (const v of a(r.Vulnerabilities).map(o)) {
      findings.push({
        id: s(v.VulnerabilityID) ?? 'unknown-vulnerability', severity: s(v.Severity), package: s(v.PkgName), ecosystem, version: s(v.InstalledVersion),
        fixedVersion: s(v.FixedVersion), title: [s(v.Title), ...a(v.CweIDs).map(String)].filter(Boolean).join(' ') || (s(v.VulnerabilityID) ?? ''),
        falsePositive: s(v.Status) === 'not_affected', path: target, references: [s(v.PrimaryURL), ...a(v.References).map(String)].filter(Boolean).slice(0, 10), fingerprint: `${s(v.VulnerabilityID)}|${s(v.PkgName)}|${s(v.InstalledVersion)}|${target}`,
      });
    }
    for (const m of a(r.Misconfigurations).map(o)) {
      findings.push({ id: s(m.ID) ?? 'unknown-misconfig', severity: s(m.Severity), title: s(m.Message) ?? s(m.Title) ?? '', path: target, line: o(m.CauseMetadata).StartLine, fingerprint: `${s(m.ID)}|${target}` });
    }
    for (const sec of a(r.Secrets).map(o)) {
      findings.push({ id: s(sec.RuleID) ?? 'unknown-secret', severity: s(sec.Severity), title: s(sec.Title) ?? 'secret detected', path: target, line: sec.StartLine, fingerprint: `${s(sec.RuleID)}|${target}|${sec.StartLine}` });
    }
    for (const l of a(r.Licenses).map(o)) {
      findings.push({ id: `license:${s(l.Name) ?? 'unknown'}`, severity: s(l.Severity), package: s(l.PkgName), title: `license ${s(l.Name) ?? 'unknown'}`, path: target, fingerprint: `${s(l.Name)}|${s(l.PkgName)}` });
    }
  }
  // A scan that found packages reports a lang-pkgs/os-pkgs result even with no vulnerabilities.
  const applicable = results.some((r) => ['lang-pkgs', 'os-pkgs', 'config', 'secret', 'license'].includes(s(r.Class) ?? ''));
  return { findings, applicable };
}

export interface TrivyPluginOptions {
  domain: TrivyDomain;
  target: string;
  exec: TrivyExec;
  /** Advisory DB build time from the worker's trivy metadata; absent when no DB. */
  readDbUpdatedAt: () => Promise<string | undefined>;
  /** Verified identity of the scanner that ran (digest/signature are checked by the runner's trust policy). */
  observed?: () => Promise<NonNullable<PluginRunOutput['observed']>>;
}

export function trivyPlugin(opts: TrivyPluginOptions): CheckProviderPlugin {
  return {
    probe: async () => ({ dbUpdatedAt: await opts.readDbUpdatedAt() }),
    async run({ signal }): Promise<PluginRunOutput> {
      const res = await opts.exec(buildTrivyArgv({ domain: opts.domain, target: opts.target }), signal);
      if (res.exitCode !== 0) throw new Error(`trivy exited with code ${res.exitCode}`);
      let report: unknown;
      try { report = JSON.parse(res.stdout); } catch { throw new Error('trivy produced non-JSON output'); }
      const { findings, applicable } = trivyToGenericFindings(report);
      const common = { dbUpdatedAt: await opts.readDbUpdatedAt(), observed: await opts.observed?.() };
      if (!applicable) return { format: 'json', document: { findings: [] }, notApplicable: 'no lockfile or scannable package manifest found', ...common };
      return { format: 'json', document: { findings }, ...common };
    },
  };
}
