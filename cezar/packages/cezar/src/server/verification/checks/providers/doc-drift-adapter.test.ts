import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema } from '../check-provider.js';
import { runCheck } from '../check-runner.js';
import { baselineFrom, evaluateFindingGate } from '../finding-policy.js';
import { checkDocReferences, docDriftPlugin, driftFindings, resolveRelative, slug, type DocFile, type DriftResult } from './doc-drift-adapter.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-16T12:00:00Z');
const FILES = new Set(['docs/guide.md', 'docs/other.md', 'src/app/main.ts', 'README.md']);
const lookups = { fileExists: (p: string) => FILES.has(p), symbolExists: (p: string, s: string) => p === 'src/app/main.ts' && ['start', 'Server.run'].includes(s) };
const docText: Record<string, string> = { 'docs/other.md': '# Other\n\n## Setup steps\n' };
const readDoc = (p: string) => docText[p];
const doc = (text: string, path = 'docs/guide.md'): DocFile => ({ path, text });

describe('path helpers', () => {
  it('resolves relative targets and refuses to escape the repository', () => {
    expect(resolveRelative('docs/guide.md', './other.md')).toBe('docs/other.md');
    expect(resolveRelative('docs/guide.md', '../src/app/main.ts')).toBe('src/app/main.ts');
    expect(resolveRelative('docs/guide.md', '../../outside.md')).toBeUndefined();
    expect(resolveRelative('README.md', 'docs/guide.md')).toBe('docs/guide.md');
    expect(slug('Setup steps')).toBe('setup-steps');
  });
});

describe('broken references in changed docs', () => {
  it('finds missing link targets, anchors and backticked repository paths with file and line', () => {
    const f = checkDocReferences(doc([
      '# Guide', '', 'See [other](./other.md) and [missing](./nope.md).', 'Jump to [setup](./other.md#setup-steps) or [bad](./other.md#gone).',
      'In-page [ok](#guide) and [broken](#nowhere).', 'The entry is `src/app/main.ts` but `src/app/ghost.ts` is gone.', 'Symbol `src/app/main.ts#start` and `src/app/main.ts#missing`.',
    ].join('\n')), lookups, readDoc);
    expect(f.map((x) => [x.id, x.line])).toEqual([
      ['docs.broken-link:docs/nope.md', 3], ['docs.broken-anchor:docs/other.md#gone', 4], ['docs.broken-anchor:nowhere', 5], ['docs.missing-path:src/app/ghost.ts', 6], ['docs.missing-symbol:src/app/main.ts#missing', 7],
    ]);
  });

  it('ignores external URLs, fenced code, valid references and images of existing files', () => {
    const f = checkDocReferences(doc(['[web](https://example.org/x) [mail](mailto:a@b.c) [proto](//cdn.example/x)', '```', '[broken](./nope.md) `src/app/ghost.ts`', '```', '![img](../README.md) `src/app/main.ts`'].join('\n')), lookups, readDoc);
    expect(f).toEqual([]);
  });

  it('a link that escapes the repository is broken', () => {
    expect(checkDocReferences(doc('[x](../../../etc/passwd)'), lookups, readDoc)[0]).toMatchObject({ id: 'docs.broken-link:../../../etc/passwd', severity: 'medium' });
  });

  it('skips symbol checks when no symbol lookup is provided', () => {
    expect(checkDocReferences(doc('`src/app/main.ts#nothing`'), { fileExists: lookups.fileExists }, readDoc)).toEqual([]);
  });
});

describe('decision drift exposed from existing results', () => {
  const results: DriftResult[] = [
    { decisionId: 'ADR-7', state: 'drifted', summary: 'code now uses a queue, the decision says polling', evidence: ['commit abc1234', 'run r-9'], files: ['src/app/main.ts'] },
    { decisionId: 'ADR-8', state: 'in-sync', summary: 'ok', evidence: [], files: [] },
    { decisionId: 'ADR-9', state: 'unknown', summary: 'no code references found', evidence: [], files: [] },
  ];
  it('a drifted decision is a finding with its evidence as provenance; in-sync is silent; unknown is informational', () => {
    const f = driftFindings(results);
    expect(f.map((x) => [x.id, x.severity])).toEqual([['docs.decision-drift:ADR-7', 'medium'], ['docs.decision-unverified:ADR-9', 'info']]);
    expect(f[0]!.title).toContain('commit abc1234, run r-9');
    expect(f[0]!.path).toBe('src/app/main.ts');
  });
});

describe('through the check pipeline', () => {
  const def = checkProviderConfigSchema.parse({ version: 1, checks: [{ id: 'docs', category: 'custom', provider: { name: 'docs', version: '1', digest: DIGEST }, scopes: ['changed-files'], triggers: ['pr-dev'], policy: { mandatory: false, timeoutMs: 1000 } }] }).checks[0]!;
  const run = (docs: DocFile[], drift: DriftResult[] = []) => runCheck({ definition: def, plugin: docDriftPlugin({ changedDocs: async () => docs, lookups, readDoc, readDrift: async () => drift }), sourceSha: 'c'.repeat(40), scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW });

  it('only changed docs are examined, so existing breakage elsewhere cannot appear', async () => {
    const clean = await run([doc('[ok](./other.md)')]);
    expect(clean.result.status).toBe('pass');
    expect((await run([doc('plain text', 'notes.txt')])).result.status).toBe('unknown'); // nothing applicable ran: not a pass
  });

  it('a new broken reference or decision drift is a finding; existing debt is visible but does not block', async () => {
    const old = await run([doc('[gone](./old-missing.md)')]);
    const baseline = baselineFrom(old.findings, new Date('2026-11-01T00:00:00Z'), 'alice');
    const now = await run([doc('[gone](./old-missing.md)\n[new](./new-missing.md)')], [{ decisionId: 'ADR-7', state: 'drifted', summary: 's', evidence: ['e1'], files: ['src/app/main.ts'] }]);
    expect(now.findings.map((f) => f.ruleId).sort()).toEqual(['docs.broken-link:docs/new-missing.md', 'docs.broken-link:docs/old-missing.md', 'docs.decision-drift:ADR-7']);
    const lenient = evaluateFindingGate({ findings: now.findings, baseline, now: NOW });
    expect(lenient.blocked).toBe(false);
    expect(lenient.visibleDebt.qualityDebt).toBe(1);
    const strict = evaluateFindingGate({ findings: now.findings, baseline, now: NOW, policy: { blockSecurityAt: 'high', blockQualityDebtAt: 'medium' } });
    expect(strict.blocked).toBe(true);
    expect(strict.blocking).toHaveLength(2);   // the new link and the drift, not the baselined one
  });
});
