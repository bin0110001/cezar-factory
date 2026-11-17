import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Native unit-test adapter (#669): reads the JUnit XML that test runners (vitest, pytest, dotnet test, GdUnit) already write and
 * turns each failing test case into a finding in the `test` category. A run that executed no tests is reported `unknown` (an
 * unexecuted suite is not a pass), a crash or unreadable report is an error. `exec` runs in the isolated worker; this module
 * spawns nothing.
 */

export interface JunitSummary { tests: number; failures: number; errors: number; skipped: number }
export interface JunitCase { classname: string; name: string; message?: string; kind: 'failure' | 'error' }

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Parse a JUnit report. Throws when it does not look like one, so a garbage file is an error, never an empty pass. */
export function parseJunitXml(xml: string): { summary: JunitSummary; cases: JunitCase[] } {
  const suites = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map((m) => m[0]);
  if (suites.length === 0) throw new Error('not a JUnit report: no <testsuite> element');
  const num = (tag: string, n: string) => Number(attr(tag, n) ?? 0) || 0;
  const summary = suites.reduce<JunitSummary>((a, t) => ({ tests: a.tests + num(t, 'tests'), failures: a.failures + num(t, 'failures'), errors: a.errors + num(t, 'errors'), skipped: a.skipped + num(t, 'skipped') }), { tests: 0, failures: 0, errors: 0, skipped: 0 });
  const cases: JunitCase[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = m[1] ?? '';
    const body = m[2] ?? '';
    const bad = /<(failure|error)\b([^>]*)/.exec(body);
    if (bad) cases.push({ classname: decode(attr(tag, 'classname') ?? ''), name: decode(attr(tag, 'name') ?? 'unnamed'), kind: bad[1] === 'error' ? 'error' : 'failure', ...(attr(bad[2] ?? '', 'message') ? { message: decode(attr(bad[2] ?? '', 'message')!) } : {}) });
  }
  return { summary, cases };
}

export interface JunitPluginOptions {
  /** Runs the test command and returns the JUnit XML it wrote, plus the process exit code. */
  exec: (signal: AbortSignal) => Promise<{ exitCode: number; reportXml: string }>;
}

export function junitPlugin(opts: JunitPluginOptions): CheckProviderPlugin {
  return {
    async run({ signal }): Promise<PluginRunOutput> {
      const res = await opts.exec(signal);
      if (!res.reportXml.trim()) throw new Error(`test runner produced no report (exit code ${res.exitCode})`);
      const { summary, cases } = parseJunitXml(res.reportXml);
      if (summary.tests === 0) return { format: 'json', document: { findings: [] }, notApplicable: 'the suite executed no tests', noFeed: true };
      // A failing exit with no failing case means the runner itself broke (build error, crash): not a verdict on the tests.
      if (res.exitCode !== 0 && cases.length === 0) throw new Error(`test runner exited with code ${res.exitCode} without a failing test`);
      const findings = cases.map((c) => ({ id: `test:${c.classname}.${c.name}`, severity: 'high', title: c.message ?? `${c.kind}: ${c.name}`, path: c.classname || undefined }));
      return { format: 'json', document: { findings }, noFeed: true };
    },
  };
}
