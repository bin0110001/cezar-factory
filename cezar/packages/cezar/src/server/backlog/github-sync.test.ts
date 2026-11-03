import { afterEach, describe, expect, it } from 'vitest';
import { upsertBacklogMetadata } from './github-metadata.ts';
import { DEFAULT_FIELDS } from './model.ts';
import { ObligationStore } from './integration-obligations.ts';
import { materializeObligationIssue, reconcileObligationOutcome, syncIssue, syncOpenIssues, syncRepository, type GhRunner } from './github-sync.ts';
import { BacklogStore } from './store.ts';

const R = 'o/r';
const open: Array<{ close(): void }> = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const store = () => { const s = new BacklogStore({ path: ':memory:' }); open.push(s); return s; };

/** Tiny in-memory GitHub: issues by number, plus hooks to simulate outages and racing editors. */
function fakeGithub(initial: Record<number, { body: string; labels?: string[]; state?: string }>) {
  const issues = new Map(Object.entries(initial).map(([n, v]) => [Number(n), { body: v.body, labels: v.labels ?? [], state: v.state ?? 'open' }]));
  const calls: string[][] = [];
  const created: Array<{ title: string; body: string }> = [];
  const state = { down: false, raceOnPatch: null as null | ((n: number) => void), listResult: [] as Array<{ number: number }> };
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (state.down) throw new Error('connect ETIMEDOUT');
    if (args[0] === 'api' && args[1]?.startsWith('repos/')) {
      const n = Number(args[1].split('/').pop());
      const issue = issues.get(n);
      if (!issue) throw new Error('404');
      return JSON.stringify({ number: n, body: issue.body, state: issue.state, labels: issue.labels.map((name) => ({ name })) });
    }
    if (args[0] === 'api' && args[1] === '-X' && args[2] === 'PATCH') {
      const n = Number(args[3]!.split('/').pop());
      const body = args[5]!.replace(/^body=/, '');
      issues.get(n)!.body = body;
      state.raceOnPatch?.(n); // a human edit lands right after our write
      return '{}';
    }
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(state.listResult);
    if (args[0] === 'issue' && args[1] === 'create') {
      created.push({ title: args[args.indexOf('--title') + 1]!, body: args[args.indexOf('--body') + 1]! });
      return `https://github.com/${R}/issues/${300 + created.length}`;
    }
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return { gh, issues, calls, created, state };
}
const block = (fields: Partial<typeof DEFAULT_FIELDS>, version: number, origin = 'bob') =>
  upsertBacklogMetadata('Issue text', { fields: { ...DEFAULT_FIELDS, ...fields }, version, origin, writeId: `w${version}`, updatedAt: '2026-11-03T00:00:00Z' });

describe('GitHub sync driver', () => {
  it('seeds from labels, pushes the projection into the issue body, then is a no-op', async () => {
    const s = store();
    const g = fakeGithub({ 1: { body: 'Plain issue text', labels: ['P1', 'factory:ready'] } });
    expect(await syncIssue({ store: s, repository: R, issueNumber: 1, gh: g.gh })).toMatchObject({ status: 'pushed' });
    expect(g.issues.get(1)!.body).toContain('Plain issue text');
    expect(g.issues.get(1)!.body).toContain('factory-backlog:v1');
    expect(s.get(R, 1)).toMatchObject({ basePriority: 'P1', lane: 'Ready' });
    expect(await syncIssue({ store: s, repository: R, issueNumber: 1, gh: g.gh })).toMatchObject({ status: 'in-sync' });
  });
  it('pulls a human edit made on GitHub and never loops it back', async () => {
    const s = store();
    const g = fakeGithub({ 2: { body: block({ basePriority: 'P0', lane: 'Backlog' }, 4) } });
    expect(await syncIssue({ store: s, repository: R, issueNumber: 2, gh: g.gh })).toMatchObject({ status: 'pulled' });
    expect(s.get(R, 2)).toMatchObject({ basePriority: 'P0', lane: 'Backlog' });
    const patches = g.calls.filter((c) => c[2] === 'PATCH').length;
    await syncIssue({ store: s, repository: R, issueNumber: 2, gh: g.gh });
    expect(g.calls.filter((c) => c[2] === 'PATCH').length).toBe(patches);
  });
  it('surfaces simultaneous edits as a conflict and writes neither side over the other', async () => {
    const s = store();
    const g = fakeGithub({ 3: { body: block({}, 1) } });
    await syncIssue({ store: s, repository: R, issueNumber: 3, gh: g.gh });
    s.update(R, 3, { basePriority: 'P2' }, { actor: 'alice' });
    g.issues.get(3)!.body = block({ basePriority: 'P0' }, 2);
    const out = await syncIssue({ store: s, repository: R, issueNumber: 3, gh: g.gh });
    expect(out).toMatchObject({ status: 'conflict', fields: ['basePriority'] });
    expect(s.get(R, 3)!.basePriority).toBe('P2');
    expect(g.issues.get(3)!.body).toContain('"basePriority":"P0"');
  });
  it('detects a human edit racing our write (read-after-write) and keeps the change queued', async () => {
    const s = store();
    const g = fakeGithub({ 4: { body: block({}, 1) } });
    await syncIssue({ store: s, repository: R, issueNumber: 4, gh: g.gh });
    s.update(R, 4, { scope: 'mine' }, { actor: 'alice' });
    g.state.raceOnPatch = (n) => { g.issues.get(n)!.body = block({ scope: 'theirs' }, 9); g.state.raceOnPatch = null; };
    expect(await syncIssue({ store: s, repository: R, issueNumber: 4, gh: g.gh })).toMatchObject({ status: 'lost-update' });
    expect(s.pendingPush(R, 4)).not.toBeNull();
    expect(await syncIssue({ store: s, repository: R, issueNumber: 4, gh: g.gh })).toMatchObject({ status: 'conflict', fields: ['scope'] });
  });
  it('queues through a GitHub outage and reconciles deterministically on return', async () => {
    const s = store();
    const g = fakeGithub({ 5: { body: block({}, 1) }, 6: { body: block({}, 1) } });
    await syncRepository({ store: s, repository: R, issueNumbers: [5, 6], gh: g.gh });
    s.update(R, 5, { basePriority: 'P3' }, { actor: 'alice' });
    g.state.down = true;
    const down = await syncRepository({ store: s, repository: R, issueNumbers: [6, 5], gh: g.gh });
    expect(down.map((d) => [d.issue, d.status])).toEqual([[5, 'offline'], [6, 'offline']]);
    expect(g.calls.filter((c) => c[0] === 'api').length).toBeLessThan(12); // failed fast, did not retry every issue
    expect(s.pendingPush(R, 5)).not.toBeNull();
    g.state.down = false;
    const up = await syncRepository({ store: s, repository: R, issueNumbers: [5, 6], gh: g.gh });
    expect(up.map((d) => d.status)).toEqual(['pushed', 'in-sync']);
    expect(g.issues.get(5)!.body).toContain('"basePriority":"P3"');
  });
  it('skips pull requests', async () => {
    const s = store();
    const gh: GhRunner = async () => JSON.stringify({ number: 7, body: 'x', state: 'open', labels: [], pull_request: {} });
    expect(await syncIssue({ store: s, repository: R, issueNumber: 7, gh })).toMatchObject({ status: 'in-sync' });
    expect(s.get(R, 7)).toBeNull();
  });
});

describe('obligation issue materialization', () => {
  it('creates exactly one linked issue, reuses an existing marker, and is idempotent', async () => {
    const obligations = new ObligationStore({ path: ':memory:' }); open.push(obligations);
    const key = 'integration:o/r#1+o/r#2';
    obligations.ensure(R, 'o/r#1', 'o/r#2', key, { kind: 'forced-overlap', detail: 'alice: deadline' });
    const g = fakeGithub({});
    const first = await materializeObligationIssue({ obligations, key, repository: R, gh: g.gh });
    expect(first).toMatchObject({ created: true, number: 301 });
    expect(g.created[0]!.body).toContain(`factory-obligation:${key}`);
    expect(g.created[0]!.body).toContain('forced-overlap');
    expect(await materializeObligationIssue({ obligations, key, repository: R, gh: g.gh })).toMatchObject({ created: false, number: 301 });
    expect(g.created).toHaveLength(1);

    const key2 = 'integration:o/r#3+o/r#4';
    obligations.ensure(R, 'o/r#3', 'o/r#4', key2, { kind: 'k', detail: 'd' });
    g.state.listResult = [{ number: 555 }]; // a prior crashed run already created it
    expect(await materializeObligationIssue({ obligations, key: key2, repository: R, gh: g.gh })).toMatchObject({ created: false, number: 555 });
    expect(g.created).toHaveLength(1);
  });
});

describe('composed flows', () => {
  it('turns a failed-verification merge into exactly one integration-agent issue, and a clean one into none', async () => {
    const obligations = new ObligationStore({ path: ':memory:' }); open.push(obligations);
    const g = fakeGithub({});
    const k1 = 'integration:o/r#1+o/r#2', k2 = 'integration:o/r#3+o/r#4';
    obligations.ensure(R, 'o/r#1', 'o/r#2', k1, { kind: 'k', detail: 'd' });
    obligations.ensure(R, 'o/r#3', 'o/r#4', k2, { kind: 'k', detail: 'd' });
    const bad = await reconcileObligationOutcome({ obligations, key: k1, repository: R, gh: g.gh, outcome: { kind: 'clean-merge', verification: 'failed' } });
    expect(bad).toMatchObject({ needsIntegrationAgent: true, githubIssue: 301 });
    expect(bad.obligation.state).toBe('needs-agent');
    const again = await reconcileObligationOutcome({ obligations, key: k1, repository: R, gh: g.gh, outcome: { kind: 'textual-conflict', paths: ['a'] } });
    expect(again.githubIssue).toBe(301);
    expect(g.created).toHaveLength(1);
    obligations.transition(k1, 'resolved', { kind: 'human', detail: 'fixed by agent' });
    const clean = await reconcileObligationOutcome({ obligations, key: k2, repository: R, gh: g.gh, outcome: { kind: 'clean-merge', verification: 'passed' } });
    expect(clean).toMatchObject({ needsIntegrationAgent: false, githubIssue: null });
    expect(g.created).toHaveLength(1);
  });
  it('syncs open issues plus already-known ones', async () => {
    const s = store();
    const g = fakeGithub({ 1: { body: block({}, 1) }, 2: { body: block({}, 1) }, 9: { body: block({}, 1), state: 'closed' } });
    s.ensureFromLabels(R, 9, { labels: [], issueState: 'open' });
    const orig = g.gh;
    const gh: GhRunner = async (args) => (args[0] === 'issue' && args[1] === 'list' && args.includes('open') ? JSON.stringify([{ number: 1 }, { number: 2 }]) : orig(args));
    const results = await syncOpenIssues({ store: s, repository: R, gh });
    expect(results.map((r) => r.issue).sort()).toEqual([1, 2, 9]);
    expect(s.get(R, 9)!.issueState).toBe('closed');
  });
});
