import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DependencyGraphNode, DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIFECYCLE, lifecycleFromPolicy, loadLifecycleKinds } from './lifecycle-model.ts';
import { diagnoseStalls } from './stalls.ts';

const here = dirname(fileURLToPath(import.meta.url));
// This package is vendored in the Factory repository, whose policy is the real input. Skip when it is absent
// (the package tested on its own).
const shippedPolicy = resolve(here, '../../../../../../policies/lifecycle.json');
const sorted = (set: ReadonlySet<string>) => [...set].sort();

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'lifecycle-model-')); cleanup.push(dir); return dir; };

const policy = (extra: Record<string, unknown> = {}) => ({
  profiles: {
    standard: { states: { 'factory:ready': { kind: 'automated' }, 'factory:working': { kind: 'in-run' }, 'factory:needs-help': { kind: 'human' }, 'factory:blocked': { kind: 'human' }, 'factory:review': { kind: 'automated', inFlight: true } } },
    ...extra,
  },
});

describe('lifecycleFromPolicy', () => {
  it.skipIf(!existsSync(shippedPolicy))('derives exactly the standard process from the shipped policy, so the detector behaves as before', () => {
    const derived = lifecycleFromPolicy(JSON.parse(readFileSync(shippedPolicy, 'utf8')))!;
    // The shipped policy also carries variant profiles; the standard process is the subset they all extend.
    for (const label of DEFAULT_LIFECYCLE.stateLabels) expect(derived.stateLabels.has(label), label).toBe(true);
    for (const label of DEFAULT_LIFECYCLE.humanWait) expect(derived.humanWait.has(label), label).toBe(true);
    for (const label of DEFAULT_LIFECYCLE.inFlight) expect(derived.inFlight.has(label), label).toBe(true);
    // And nothing from the standard profile that the detector did not already know, except what a variant adds.
    const standardOnly = lifecycleFromPolicy({ profiles: { standard: (JSON.parse(readFileSync(shippedPolicy, 'utf8')) as { profiles: { standard: unknown } }).profiles.standard } })!;
    expect(sorted(standardOnly.stateLabels)).toEqual(sorted(DEFAULT_LIFECYCLE.stateLabels));
    expect(sorted(standardOnly.humanWait)).toEqual(sorted(DEFAULT_LIFECYCLE.humanWait));
    expect(sorted(standardOnly.inFlight)).toEqual(sorted(DEFAULT_LIFECYCLE.inFlight));
  });

  it('treats factory:blocked as a state but not as a person-owned wait, and honours the inFlight flag', () => {
    const derived = lifecycleFromPolicy(policy())!;
    expect(derived.stateLabels.has('factory:blocked')).toBe(true);
    expect(sorted(derived.humanWait)).toEqual(['factory:needs-help']);
    expect(sorted(derived.inFlight)).toEqual(['factory:review', 'factory:working']);
  });

  it('knows a state that only a variant profile defines, through extends', () => {
    const derived = lifecycleFromPolicy(policy({ gated: { extends: 'standard', states: { 'factory:design-signoff': { kind: 'human' } } } }))!;
    expect(derived.stateLabels.has('factory:design-signoff')).toBe(true);
    expect(derived.humanWait.has('factory:design-signoff')).toBe(true);
    expect(derived.stateLabels.has('factory:ready')).toBe(true);
  });

  it('refuses what is not a policy', () => {
    expect(lifecycleFromPolicy(null)).toBeUndefined();
    expect(lifecycleFromPolicy({ profiles: 3 })).toBeUndefined();
    expect(lifecycleFromPolicy({ profiles: {} })).toBeUndefined();
    expect(lifecycleFromPolicy({ profiles: { standard: { states: { 'factory:ready': { kind: 5 } } } } })).toBeUndefined();
  });
});

describe('loadLifecycleKinds', () => {
  it('reads the policy from the Factory checkout, then from a managed project, and otherwise defaults', () => {
    const factory = tempRoot();
    mkdirSync(join(factory, 'policies'));
    writeFileSync(join(factory, 'policies', 'lifecycle.json'), JSON.stringify(policy()));
    expect(loadLifecycleKinds(factory)?.stateLabels.has('factory:ready')).toBe(true);

    const managed = tempRoot();
    mkdirSync(join(managed, '.ai', 'factory', 'policies'), { recursive: true });
    writeFileSync(join(managed, '.ai', 'factory', 'policies', 'lifecycle.json'), JSON.stringify(policy({ gated: { extends: 'standard', states: { 'factory:design-signoff': { kind: 'human' } } } })));
    expect(loadLifecycleKinds(managed)?.humanWait.has('factory:design-signoff')).toBe(true);

    expect(loadLifecycleKinds(tempRoot())).toBeUndefined();
    const broken = tempRoot();
    mkdirSync(join(broken, 'policies'));
    writeFileSync(join(broken, 'policies', 'lifecycle.json'), '{ not json');
    expect(loadLifecycleKinds(broken)).toBeUndefined();
  });
});

// A minimal open issue node, in the shape the detector reads.
const issue = (number: number, labels: string[]): DependencyGraphNode => ({
  id: `issue:github.com/o/r:${number}`, kind: 'issue', number, title: `Issue ${number}`, state: 'open', labels,
} as unknown as DependencyGraphNode);
const snapshot = (nodes: DependencyGraphNode[]): DependencyGraphSnapshot => ({
  revision: 1, nodes, edges: [], source: { status: 'fresh' },
} as unknown as DependencyGraphSnapshot);

describe('diagnoseStalls with the lifecycle', () => {
  const consumed = new Set(['factory:ready']);
  const gatedPolicy = lifecycleFromPolicy(policy({ gated: { extends: 'standard', states: { 'factory:design-signoff': { kind: 'human' } } } }))!;

  it('reports an issue waiting at a profile-only human state as waiting on a person, not as having no state', () => {
    const report = diagnoseStalls({ snapshot: snapshot([issue(1, ['factory:design-signoff'])]), consumedLabels: consumed, lifecycle: gatedPolicy });
    expect(report.items[0]).toMatchObject({ class: 'waiting', reason: 'waiting-on-human' });
  });

  it('without that policy the same label is unknown, which is the behaviour this replaces', () => {
    const report = diagnoseStalls({ snapshot: snapshot([issue(1, ['factory:design-signoff'])]), consumedLabels: consumed });
    expect(report.items[0]).toMatchObject({ class: 'stuck', reason: 'no-state-label' });
  });

  it('keeps the standard process when no lifecycle is given', () => {
    const report = diagnoseStalls({ snapshot: snapshot([issue(1, ['factory:needs-help']), issue(2, ['factory:working']), issue(3, ['factory:ready'])]), consumedLabels: consumed });
    expect(report.items.map((item) => [item.number, item.class]).sort()).toEqual([[1, 'waiting'], [2, 'running'], [3, 'runnable']]);
  });
});
