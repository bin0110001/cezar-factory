import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, configHash, effectiveConfig, errorPath, nextRuns, validateDocument } from './pipeline-policy.ts';

interface Case { name: string; doc: Record<string, unknown>; project: string; valid: boolean; errors: string[]; effective?: Record<string, unknown>; hash?: string }
const fixture = JSON.parse(readFileSync(new URL('../../../../../tests/fixtures/release-pipeline-cases.json', import.meta.url), 'utf8')) as { cases: Case[] };
const paths = (errors: string[]) => [...new Set(errors.map(errorPath))].sort();

describe('parity with the Python authority (shared fixture)', () => {
  it.each(fixture.cases)('$name', (c) => {
    const errors = validateDocument(c.doc);
    expect(errors.length === 0, `TS says ${errors.join(' | ')}`).toBe(c.valid);
    expect(paths(errors)).toEqual(paths(c.errors));
    if (c.valid) {
      const spec = effectiveConfig(c.doc, c.project);
      expect(spec).toEqual(c.effective);
      expect(configHash(spec)).toBe(c.hash);   // the same effective hash the engine records on a candidate
    }
  });

  it('covers the acceptance cases: both pilot schedules, legacy default, and the unsafe cases', () => {
    const names = fixture.cases.map((c) => c.name);
    for (const n of ['example:tableflux', 'example:cezar-factory', 'example:legacy-project', 'unsafe auto promotion', 'two active candidates', 'branch collision']) expect(names).toContain(n);
    expect(fixture.cases.filter((c) => c.valid).length).toBeGreaterThanOrEqual(5);
  });
});

describe('effective preview and next-run dry run', () => {
  const example = fixture.cases.find((c) => c.name === 'example:tableflux')!.doc;
  const NOW = new Date('2026-11-16T12:00:00Z');

  it('previews TableFlux weekly and cezar-factory daily from the same document', () => {
    const weekly = nextRuns(effectiveConfig(example, 'tableflux'), NOW);
    const daily = nextRuns(effectiveConfig(example, 'cezar-factory'), NOW);
    expect(weekly).toEqual(['2026-11-19T08:00:00Z', '2026-11-26T08:00:00Z', '2026-12-03T08:00:00Z']);  // Thursday 03:00 America/Detroit
    expect(daily).toHaveLength(3);
    expect(daily[0]).toBe('2026-11-17T09:30:00Z');  // 04:30 local
    expect(nextRuns(effectiveConfig(example, 'legacy-project'), NOW)).toEqual([]);
  });

  it('keeps the local time across a DST change', () => {
    const doc = { schemaVersion: 'release-pipeline/v1', projects: { p: { preset: 'daily-calendar', triggers: { schedule: { hour: 3, minute: 0 } }, tests: { suites: ['s'], required: ['s'] } } } };
    const runs = nextRuns(effectiveConfig(doc, 'p'), new Date('2026-03-06T12:00:00Z'), 4);
    expect(runs).toEqual(['2026-03-07T08:00:00Z', '2026-03-08T07:00:00Z', '2026-03-09T07:00:00Z', '2026-03-10T07:00:00Z']); // 03:00 EST then EDT
  });

  it('refuses to preview an invalid document and explains the paths', () => {
    expect(() => effectiveConfig({ schemaVersion: 'release-pipeline/v1', projects: { p: { promotion: { stable: 'auto', review: 'self-review' } } } }, 'p')).toThrow(ConfigError);
    try { effectiveConfig({ schemaVersion: 'release-pipeline/v1', projects: { p: { promotion: { bogus: 1 } } } }, 'p'); } catch (e) {
      expect((e as ConfigError).errors[0]).toContain('projects.p.promotion.bogus: unknown field');
    }
  });
});
