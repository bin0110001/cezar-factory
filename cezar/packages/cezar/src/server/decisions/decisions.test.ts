import { describe, expect, it } from 'vitest';
import {
  answerDecision,
  buildDecisionItem,
  listDecisions,
  parseDecisionMarker,
  renderAnswerComment,
  type GhRunner,
} from './decisions.ts';

const GT = '\\u003e';
const ask = {
  version: 1,
  decisions: [{
    id: 'state-owner',
    question: 'Where should run state live?',
    context: 'Two stores exist.',
    recommendedOptionId: 'registry',
    options: [
      { id: 'registry', label: 'Shared registry', summary: 'One owner', tradeoffs: 'Needs a migration' },
      { id: 'local', label: 'Per-project file' },
    ],
  }],
};
const marker = (value: unknown) => `<!-- factory-decision:v1 ${JSON.stringify(value).replace(/>/g, GT)} -->`;
const structuredComment = (extra = '') => ({ createdAt: '2026-11-01T10:00:00Z', body: `## Factory decision needed\n\n### Where should run state live?\n\n${marker(ask)}${extra}` });
const legacyComment = {
  createdAt: '2026-10-01T10:00:00Z',
  body: '## Factory escalation\n\n**Observed problem**\n- Which data source is authoritative?\n- It also affects billing.\n\n**Attempts made**\nIntake.',
};
type TestIssue = Parameters<typeof buildDecisionItem>[0];
const issue = (over: Partial<TestIssue> = {}): TestIssue => ({ number: 7, title: 'Pick storage', url: 'https://github.com/o/r/issues/7', updatedAt: '2026-11-02T00:00:00Z', labels: [{ name: 'factory:needs-help' }], comments: [], ...over });

describe('parseDecisionMarker', () => {
  it('reads structured decisions, including text with an escaped angle bracket', () => {
    const body = marker({ ...ask, decisions: [{ ...ask.decisions[0], context: 'a --> b' }] });
    expect(body.match(/-->/g)).toHaveLength(1);
    expect(parseDecisionMarker(body)?.[0]?.context).toBe('a --> b');
  });

  it('rejects malformed JSON, a missing list, and questions with fewer than two paths', () => {
    expect(parseDecisionMarker('no marker here')).toBeNull();
    expect(parseDecisionMarker('<!-- factory-decision:v1 {nope -->')).toBeNull();
    expect(parseDecisionMarker(marker({ version: 1 }))).toBeNull();
    expect(parseDecisionMarker(marker({ version: 1, decisions: [{ id: 'a', question: 'q', options: [{ id: 'x', label: 'X' }] }] }))).toBeNull();
  });
});

describe('buildDecisionItem', () => {
  it('prefers the newest structured ask and hides the machine marker from details', () => {
    const older = { createdAt: '2026-10-30T00:00:00Z', body: marker({ version: 1, decisions: [{ id: 'old', question: 'old?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }) };
    const item = buildDecisionItem(issue({ comments: [older, structuredComment()] }), 'factory:needs-help');
    expect(item.source).toBe('structured');
    expect(item.decisions.map((d) => d.id)).toEqual(['state-owner']);
    expect(item.askedAt).toBe('2026-11-01T10:00:00Z');
    expect(item.details).toContain('Where should run state live?');
    expect(item.details).not.toContain('factory-decision:v1');
  });

  it('degrades a legacy escalation to one open question with no options', () => {
    const item = buildDecisionItem(issue({ comments: [legacyComment] }), 'factory:needs-help');
    expect(item.source).toBe('legacy');
    expect(item.decisions).toHaveLength(1);
    expect(item.decisions[0]).toMatchObject({ id: 'open-question', question: 'Which data source is authoritative?', options: [] });
    expect(item.decisions[0]?.context).toContain('billing');
  });

  it('still produces an answerable question when there is no escalation comment at all', () => {
    const item = buildDecisionItem(issue(), 'factory:human-review');
    expect(item).toMatchObject({ source: 'legacy', state: 'factory:human-review' });
    expect(item.decisions[0]?.question).toContain('Pick storage');
  });
});

describe('listDecisions', () => {
  it('merges both parked states, dedupes, and lists the longest-waiting ask first', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      const label = args[args.indexOf('--label') + 1];
      return JSON.stringify(label === 'factory:needs-help'
        ? [issue({ number: 7, comments: [structuredComment()] })]
        : [issue({ number: 3, labels: [{ name: 'factory:human-review' }], comments: [legacyComment] }), issue({ number: 7 })]);
    };
    const result = await listDecisions(gh);
    expect(result.available).toBe(true);
    expect(result.items.map((i) => i.number)).toEqual([3, 7]);
    expect(result.items[1]?.state).toBe('factory:needs-help');
    expect(calls).toHaveLength(2);
  });

  it('answers available:false instead of throwing when gh fails', async () => {
    const result = await listDecisions(async () => { throw new Error('gh: command not found\nstack'); });
    expect(result).toEqual({ available: false, reason: 'gh: command not found', items: [] });
  });
});

describe('answerDecision', () => {
  function fakeGh(view: unknown) {
    const calls: string[][] = [];
    const bodies: string[] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(view);
      if (args[1] === 'comment') {
        const { readFile } = await import('node:fs/promises');
        bodies.push(await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8'));
      }
      return '';
    };
    return { gh, calls, bodies };
  }
  const open = (over: Record<string, unknown> = {}) => ({ number: 7, state: 'OPEN', labels: [{ name: 'factory:needs-help' }], comments: [structuredComment()], ...over });

  it('posts the answer, then swaps needs-help for needs-plan', async () => {
    const { gh, calls, bodies } = fakeGh(open());
    const result = await answerDecision(gh, 7, { answers: [{ decisionId: 'state-owner', optionId: 'registry', note: 'Migrate in one step' }], note: 'Keep the old file readable' });
    expect(result).toEqual({ ok: true, number: 7, state: 'factory:needs-plan' });
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['issue view', 'issue comment', 'issue edit']);
    expect(calls[2]).toEqual(['issue', 'edit', '7', '--add-label', 'factory:needs-plan', '--remove-label', 'factory:needs-help']);
    expect(bodies[0]).toContain('**Decision:** Shared registry (recommended path)');
    expect(bodies[0]).toContain('> Migrate in one step');
    expect(bodies[0]).toMatch(/<!-- factory-decision-answer:v1 \{.*"optionId":"registry".*\} -->/);
  });

  it('accepts a free-text answer on a legacy escalation', async () => {
    const { gh, bodies } = fakeGh(open({ comments: [legacyComment] }));
    const result = await answerDecision(gh, 7, { answers: [{ decisionId: 'open-question', note: 'Use the billing database.' }] });
    expect(result.ok).toBe(true);
    expect(bodies[0]).toContain('**Decision (own words):**');
    expect(bodies[0]).toContain('> Use the billing database.');
  });

  it('refuses unknown decisions and options without touching GitHub', async () => {
    const { gh, calls } = fakeGh(open());
    expect(await answerDecision(gh, 7, { answers: [{ decisionId: 'nope', optionId: 'registry' }] })).toMatchObject({ ok: false, status: 400 });
    expect(await answerDecision(gh, 7, { answers: [{ decisionId: 'state-owner', optionId: 'bogus' }] })).toMatchObject({ ok: false, status: 400 });
    expect(await answerDecision(gh, 7, { answers: [{ decisionId: 'state-owner' }] })).toMatchObject({ ok: false, status: 400 });
    expect(calls.every((c) => c[1] === 'view')).toBe(true);
  });

  it('refuses a closed issue or one that is no longer waiting', async () => {
    expect(await answerDecision(fakeGh(open({ state: 'CLOSED' })).gh, 7, { answers: [{ decisionId: 'state-owner', optionId: 'local' }] })).toMatchObject({ ok: false, status: 409 });
    const moved = fakeGh(open({ labels: [{ name: 'factory:ready' }] }));
    expect(await answerDecision(moved.gh, 7, { answers: [{ decisionId: 'state-owner', optionId: 'local' }] })).toMatchObject({ ok: false, status: 409 });
    expect(moved.calls).toHaveLength(1);
  });

  it('reports a GitHub write failure as 502 with a retry warning', async () => {
    const gh: GhRunner = async (args) => {
      if (args[1] === 'view') return JSON.stringify(open());
      if (args[1] === 'edit') throw new Error('HTTP 403 rate limit');
      return '';
    };
    const result = await answerDecision(gh, 7, { answers: [{ decisionId: 'state-owner', optionId: 'local' }] });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect((result as { message: string }).message).toContain('may already be posted');
  });
});

describe('renderAnswerComment', () => {
  it('keeps the marker JSON from closing the comment', () => {
    const text = renderAnswerComment(ask.decisions, { answers: [{ decisionId: 'state-owner', optionId: 'local', note: 'a --> b' }] });
    const payload = /<!-- factory-decision-answer:v1 (.*) -->$/.exec(text)?.[1] ?? '';
    expect(payload).not.toContain('-->');
    expect(JSON.parse(payload).answers[0].note).toBe('a --> b');
  });
});
