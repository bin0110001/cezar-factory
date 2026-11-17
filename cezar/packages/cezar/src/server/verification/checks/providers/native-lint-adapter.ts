import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Native format/lint/type-check adapters (#646): each ecosystem's own tool (ESLint and tsc for TypeScript, Ruff for Python, the
 * .NET build's SARIF error log for C#) behind the common check interface, not one cross-language linter. Parsers turn tool output
 * into the generic findings document; a lint error maps to a blocking severity and a warning to quality debt. Whether the tool
 * exists on the worker is capability planning's job (#645), so a missing tool never reaches here. `exec` runs in the isolated
 * worker (#605).
 */

export interface NativeExecResult { exitCode: number; stdout: string }
type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const rel = (p: string | undefined, root: string): string | undefined => {
  if (!p) return undefined;
  const norm = p.replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return base && norm.startsWith(`${base}/`) ? norm.slice(base.length + 1) : norm;
};

export interface ParsedFindings { format: 'json' | 'sarif'; document: unknown }

/** `eslint --format json`: severity 2 is an error (blocking), 1 a warning (quality debt). A fatal parse error is an error. */
export function parseEslint(stdout: string, root = ''): ParsedFindings {
  const files = JSON.parse(stdout) as unknown;
  if (!Array.isArray(files)) throw new Error('eslint report is not a list');
  const findings: J[] = [];
  for (const f of files.map(o)) {
    for (const m of arr(f.messages).map(o)) {
      const fatal = m.fatal === true;
      findings.push({ id: s(m.ruleId) ?? (fatal ? 'eslint-parse-error' : 'eslint'), severity: m.severity === 2 || fatal ? 'high' : 'low', title: s(m.message) ?? '',
        path: rel(s(f.filePath), root), line: typeof m.line === 'number' ? m.line : undefined });
    }
  }
  return { format: 'json', document: { findings } };
}

/** `ruff check --output-format json`: every violation is an error-level rule hit. */
export function parseRuff(stdout: string, root = ''): ParsedFindings {
  const items = JSON.parse(stdout) as unknown;
  if (!Array.isArray(items)) throw new Error('ruff report is not a list');
  const findings = items.map(o).map((v) => ({
    id: s(v.code) ?? 'ruff', severity: 'high', title: s(v.message) ?? '', path: rel(s(v.filename), root),
    line: typeof o(v.location).row === 'number' ? o(v.location).row : undefined,
  }));
  return { format: 'json', document: { findings } };
}

/** `tsc --pretty false`: lines like `src/a.ts(3,5): error TS2322: message`. Warnings do not exist in tsc. */
export function parseTsc(stdout: string, root = ''): ParsedFindings {
  const findings: J[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line);
    if (m) findings.push({ id: m[3], severity: 'high', title: m[4], path: rel(m[1], root), line: Number(m[2]) });
  }
  return { format: 'json', document: { findings } };
}

/** The .NET compiler and analyzers write a SARIF error log (`/p:ErrorLog=...`); the shared SARIF normalizer handles it. */
export function parseDotnetSarif(stdout: string): ParsedFindings {
  return { format: 'sarif', document: JSON.parse(stdout) };
}

export const NATIVE_TOOLS = {
  eslint: { argv: (targets: string[]) => ['eslint', '--format', 'json', '--', ...targets], accept: [0, 1] as const, parse: parseEslint },
  ruff: { argv: (targets: string[]) => ['ruff', 'check', '--output-format', 'json', '--', ...targets], accept: [0, 1] as const, parse: parseRuff },
  tsc: { argv: (_t: string[]) => ['tsc', '--noEmit', '--pretty', 'false'], accept: [0, 2] as const, parse: parseTsc },
  // `dotnet build` exits 1 on compile errors; the SARIF log still carries them. 0 and 1 are results, anything else is a failure.
  // The worker's `exec` returns the written `cezar-compiler.sarif` as `stdout` (the build's own console output is not a report).
  dotnet: { argv: (targets: string[]) => ['dotnet', 'build', '--no-restore', '-p:ErrorLog=cezar-compiler.sarif%2Cversion=2.1', '--', ...targets], accept: [0, 1] as const, parse: (out: string) => parseDotnetSarif(out) },
} as const;
export type NativeTool = keyof typeof NATIVE_TOOLS;

export interface NativePluginOptions {
  tool: NativeTool;
  targets: string[];
  root?: string;
  exec: (argv: string[], signal: AbortSignal) => Promise<NativeExecResult>;
}

export function nativeLintPlugin(opts: NativePluginOptions): CheckProviderPlugin {
  const t = NATIVE_TOOLS[opts.tool];
  return {
    async run({ signal }): Promise<PluginRunOutput> {
      const res = await opts.exec(t.argv(opts.targets), signal);
      if (!(t.accept as readonly number[]).includes(res.exitCode)) throw new Error(`${opts.tool} exited with code ${res.exitCode}`);
      let parsed: ParsedFindings;
      try { parsed = t.parse(res.stdout, opts.root ?? ''); } catch (e) { throw new Error(`${opts.tool} output could not be parsed: ${(e as Error).message}`); }
      return { format: parsed.format, document: parsed.document };
    },
  };
}
