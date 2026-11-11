import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  decisionRequestSchema,
  type AnswerDecisionBody,
  type DecisionItem,
  type DecisionRequest,
  type DecisionsResponse,
} from '@open-mercato/cezar-contract';

/**
 * Outstanding user decisions, read from and answered through GitHub issues.
 *
 * The Factory parks an issue in `factory:needs-help` (or `factory:human-review`) and posts an
 * escalation comment. Newer comments carry a `factory-decision:v1` marker (see
 * `scripts/route-state.ps1`, `schemas/decision.schema.json`) with the question, details and suggested
 * paths; older ones are free text and degrade to a single open question. Answering posts a
 * `factory-decision-answer:v1` comment and returns the issue to `factory:needs-plan`, the
 * transition `docs/lifecycle.md` defines for "user resolves a major architectural decision".
 *
 * `gh` is injected so tests run without GitHub, the same seam as `backlog/github-sync.ts`.
 */
export type GhRunner = (args: string[]) => Promise<string>;

export const DECISION_STATES = ['factory:needs-help', 'factory:human-review'] as const;
const RESUME_STATE = 'factory:needs-plan';
const ASK_MARKER = /<!--\s*factory-decision:v1\s+([\s\S]*?)\s*-->/;

interface IssueComment { body: string; createdAt?: string }
interface RawIssue {
  number: number;
  title: string;
  url: string;
  state?: string;
  updatedAt?: string;
  labels?: Array<{ name: string }>;
  comments?: IssueComment[];
}

export function createGhRunner(cwd: string): GhRunner {
  const run = promisify(execFile);
  return async (args) => {
    const { stdout } = await run('gh', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  };
}

/** The structured decisions in one comment body, or null when it carries no valid marker. */
export function parseDecisionMarker(body: string): DecisionRequest[] | null {
  const match = ASK_MARKER.exec(body);
  if (!match) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(match[1]!); } catch { return null; }
  const list = (parsed as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(list)) return null;
  const decisions: DecisionRequest[] = [];
  for (const entry of list) {
    const checked = decisionRequestSchema.safeParse(entry);
    // A well-formed question needs at least two paths to choose between; anything less is a free-text ask.
    if (checked.success && checked.data.options.length >= 2) decisions.push(checked.data);
  }
  return decisions.length > 0 ? decisions : null;
}

/** Strip the machine marker so the remaining comment reads as the Factory wrote it for people. */
function readable(body: string): string {
  return body.replace(ASK_MARKER, '').trim();
}

/** The "Observed problem" section of a legacy `## Factory escalation` comment. */
function legacyObserved(body: string): string | null {
  const match = /\*\*Observed problem\*\*\s*\n([\s\S]*?)(?:\n\s*\*\*Attempts made\*\*|$)/.exec(body);
  const text = match?.[1]?.trim();
  return text ? text : null;
}

function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/^[-*]\s+/, '').trim()).find((l) => l.length > 0) ?? '';
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** Fold one issue's comments into the decision the user is being asked to make. */
export function buildDecisionItem(issue: RawIssue, state: DecisionItem['state']): DecisionItem {
  const comments = issue.comments ?? [];
  const labels = (issue.labels ?? []).map((l) => l.name);
  const base = { number: issue.number, title: issue.title, url: issue.url, state, labels, updatedAt: issue.updatedAt ?? '' };

  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    const decisions = parseDecisionMarker(comment.body);
    if (decisions) {
      return { ...base, ...(comment.createdAt ? { askedAt: comment.createdAt } : {}), source: 'structured', decisions, details: readable(comment.body) };
    }
  }

  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    if (!comment.body.includes('## Factory escalation')) continue;
    const observed = legacyObserved(comment.body);
    const question = observed ? firstLine(observed) : `${issue.title} is waiting for your decision`;
    return {
      ...base,
      ...(comment.createdAt ? { askedAt: comment.createdAt } : {}),
      source: 'legacy',
      decisions: [{ id: 'open-question', question, ...(observed ? { context: observed } : {}), options: [] }],
      details: comment.body.trim(),
    };
  }

  return {
    ...base,
    source: 'legacy',
    decisions: [{ id: 'open-question', question: `${issue.title} is waiting for your decision`, options: [] }],
    details: '',
  };
}

const LIST_FIELDS = 'number,title,url,updatedAt,labels,comments';

/** Every open issue parked for a user decision, oldest ask first. */
export async function listDecisions(gh: GhRunner): Promise<DecisionsResponse> {
  const items = new Map<number, DecisionItem>();
  try {
    for (const state of DECISION_STATES) {
      const raw = await gh(['issue', 'list', '--state', 'open', '--label', state, '--limit', '100', '--json', LIST_FIELDS]);
      for (const issue of JSON.parse(raw || '[]') as RawIssue[]) {
        if (!items.has(issue.number)) items.set(issue.number, buildDecisionItem(issue, state));
      }
    }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : 'GitHub is unavailable', items: [] };
  }
  const sorted = [...items.values()].sort((a, b) => (a.askedAt ?? a.updatedAt).localeCompare(b.askedAt ?? b.updatedAt));
  return { available: true, items: sorted };
}

export type AnswerOutcome =
  | { ok: true; number: number; state: typeof RESUME_STATE }
  | { ok: false; status: 400 | 404 | 409 | 502; message: string };

function escapeForComment(json: string): string {
  return json.replace(/>/g, '\\u003e').replace(/</g, '\\u003c');
}

/** The comment that records the user's answer, readable on GitHub and parseable by the planner. */
export function renderAnswerComment(decisions: DecisionRequest[], body: AnswerDecisionBody): string {
  const lines = ['## Factory decision answered', ''];
  for (const answer of body.answers) {
    const decision = decisions.find((d) => d.id === answer.decisionId);
    const option = decision?.options.find((o) => o.id === answer.optionId);
    lines.push(`### ${decision?.question ?? answer.decisionId}`);
    if (option) lines.push(`**Decision:** ${option.label}${option.id === decision?.recommendedOptionId ? ' (recommended path)' : ''}`);
    const note = answer.note?.trim();
    if (note) lines.push(option ? '' : '**Decision (own words):**', note.split('\n').map((l) => `> ${l}`).join('\n'));
    lines.push('');
  }
  const extra = body.note?.trim();
  if (extra) lines.push('**Additional instructions**', extra.split('\n').map((l) => `> ${l}`).join('\n'), '');
  lines.push('Recorded from Cezarium. Planning resumes automatically (`factory:needs-plan`).', '');
  const payload = escapeForComment(JSON.stringify({ version: 1, answers: body.answers, ...(extra ? { note: extra } : {}) }));
  lines.push(`<!-- factory-decision-answer:v1 ${payload} -->`);
  return lines.join('\n');
}

/** Record an answer on the issue and hand it back to planning. */
export async function answerDecision(gh: GhRunner, number: number, body: AnswerDecisionBody): Promise<AnswerOutcome> {
  let issue: RawIssue;
  try {
    issue = JSON.parse(await gh(['issue', 'view', String(number), '--json', 'number,state,labels,comments'])) as RawIssue;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return /could not resolve|not found|no issue/i.test(message)
      ? { ok: false, status: 404, message: `Issue #${number} was not found` }
      : { ok: false, status: 502, message: `Could not read issue #${number} from GitHub` };
  }
  if ((issue.state ?? '').toUpperCase() !== 'OPEN') return { ok: false, status: 409, message: `Issue #${number} is closed` };
  const parked = (issue.labels ?? []).map((l) => l.name).filter((l) => (DECISION_STATES as readonly string[]).includes(l));
  if (parked.length === 0) return { ok: false, status: 409, message: `Issue #${number} is no longer waiting for a decision` };

  const item = buildDecisionItem({ ...issue, title: '', url: '' }, parked[0] as DecisionItem['state']);
  for (const answer of body.answers) {
    const decision = item.decisions.find((d) => d.id === answer.decisionId);
    if (!decision) return { ok: false, status: 400, message: `Unknown decision "${answer.decisionId}"` };
    if (answer.optionId !== undefined && !decision.options.some((o) => o.id === answer.optionId)) {
      return { ok: false, status: 400, message: `"${answer.optionId}" is not a suggested path for "${answer.decisionId}"` };
    }
    if (answer.optionId === undefined && decision.options.length > 0 && !(answer.note?.trim())) {
      return { ok: false, status: 400, message: `Choose a path or write an answer for "${answer.decisionId}"` };
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'cez-decision-'));
  try {
    const file = join(dir, 'answer.md');
    await writeFile(file, renderAnswerComment(item.decisions, body), 'utf8');
    await gh(['issue', 'comment', String(number), '--body-file', file]);
    const args = ['issue', 'edit', String(number), '--add-label', RESUME_STATE];
    for (const label of parked) args.push('--remove-label', label);
    await gh(args);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : 'unknown error';
    return { ok: false, status: 502, message: `GitHub rejected the update: ${detail}. Check the issue before retrying; the answer comment may already be posted.` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return { ok: true, number, state: RESUME_STATE };
}
