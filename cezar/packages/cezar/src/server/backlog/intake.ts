/**
 * Deterministic intake support (#194): Ready checklist evaluation and duplicate candidates.
 * Everything here is advisory input to a human: nothing closes, moves or rewrites an issue, and no
 * LLM is involved.
 */
export interface IntakeIssue {
  repository: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface ChecklistItem { id: 'acceptance' | 'dependencies' | 'scope' | 'effort-or-tests' | 'approval'; label: string; satisfied: boolean; required: boolean; hint: string }
export interface ReadinessResult {
  /** Refinement exit: every required item is satisfied. */
  ready: boolean;
  items: ChecklistItem[];
  missing: string[];
  /** Low-risk code-first work may skip the spec-heavy items (#178). */
  codeFirstBypass: boolean;
}

const has = (body: string, re: RegExp) => re.test(body);

/**
 * Ready definition. Codebase scope may be explicitly marked unknown ("Scope: unknown") — that
 * satisfies the checklist but is surfaced in the hint, because unknown coverage is not safe coverage.
 */
export function evaluateReadiness(issue: Pick<IntakeIssue, 'body' | 'labels'>): ReadinessResult {
  const labels = issue.labels.map((l) => l.toLowerCase());
  const body = issue.body;
  const risky = labels.includes('risk:high');
  const codeFirstBypass = !risky && (labels.includes('risk:low') || labels.includes('type:bug') || labels.includes('type:chore'));
  const acceptance = has(body, /^#{1,6}\s*acceptance/im) || has(body, /acceptance criteria/i) || has(body, /^\s*[-*]\s*\[[ xX]\]\s+\S/m);
  const dependencies = has(body, /(blocked[ -]by|depends on|dependencies)\s*:?/i) || has(body, /no dependencies/i) || has(body, /^#{1,6}\s*dependencies/im);
  const scope = has(body, /scope\s*:\s*unknown/i) || has(body, /(`[\w./-]+\.[a-z]{1,5}`|\b[\w-]+\/[\w./-]+\.[a-z]{1,5}\b)/i) || has(body, /^#{1,6}\s*(scope|affected|files|modules)/im);
  const effortOrTests = has(body, /(effort|estimate|points?)\s*:\s*\d+/i) || has(body, /\b(test|tests|testing)\b/i);
  const approval = !risky || has(body, /approved\s+by\s*:\s*\S+/i) || labels.includes('factory:approved');
  const items: ChecklistItem[] = [
    { id: 'acceptance', label: 'Acceptance criteria', satisfied: acceptance, required: true, hint: 'Add an "Acceptance" section or checkbox list.' },
    { id: 'dependencies', label: 'Dependencies / decision gates declared', satisfied: dependencies, required: !codeFirstBypass, hint: 'List "Blocked by #N" or state "No dependencies".' },
    { id: 'scope', label: 'Codebase scope known or marked unknown', satisfied: scope, required: !codeFirstBypass, hint: 'Name files/modules or write "Scope: unknown".' },
    { id: 'effort-or-tests', label: 'Effort or test hint', satisfied: effortOrTests, required: false, hint: 'Add "Effort: <points>" or describe tests.' },
    { id: 'approval', label: 'Approval for high-risk change', satisfied: approval, required: risky, hint: 'Add "Approved by: <name>" or the factory:approved label.' },
  ];
  const missing = items.filter((i) => i.required && !i.satisfied).map((i) => i.label);
  return { ready: missing.length === 0, items, missing, codeFirstBypass };
}

export interface DuplicateCandidate {
  a: string;
  b: string;
  /** 0..1; explicit references score 1. */
  score: number;
  evidence: string[];
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'in', 'on', 'with', 'is', 'be', 'add', 'fix', 'update']);
const tokens = (title: string) => new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t)));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Pairs worth a human look, strongest first. Same repository only; stable ordering for replay. */
export function findDuplicateCandidates(issues: IntakeIssue[], threshold = 0.7): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  const id = (i: IntakeIssue) => `${i.repository.toLowerCase()}#${i.number}`;
  const sorted = [...issues].sort((x, y) => id(x).localeCompare(id(y), 'en', { numeric: true }));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const a = sorted[i]!, b = sorted[j]!;
    if (a.repository.toLowerCase() !== b.repository.toLowerCase()) continue;
    const evidence: string[] = [];
    let score = 0;
    const refs = (from: IntakeIssue, to: IntakeIssue) => new RegExp(`(duplicate of|dup of|same as|closes|supersedes)\\s+#${to.number}\\b`, 'i').test(from.body);
    if (refs(a, b) || refs(b, a)) { score = 1; evidence.push('explicit duplicate reference'); }
    const sim = jaccard(tokens(a.title), tokens(b.title));
    if (sim >= threshold) { score = Math.max(score, sim); evidence.push(`title similarity ${sim.toFixed(2)}`); }
    const urls = (t: string) => new Set(t.match(/https?:\/\/[^\s)>\]]+/g) ?? []);
    const ua = urls(a.body), ub = urls(b.body);
    const shared = [...ua].filter((u) => ub.has(u) && !/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(u));
    if (shared.length > 0) { score = Math.max(score, 0.6); evidence.push(`shared link ${shared[0]}`); }
    if (score >= Math.min(threshold, 0.6) && evidence.length > 0 && (score >= threshold || evidence.length > 1 || score === 1)) out.push({ a: id(a), b: id(b), score: Math.round(score * 100) / 100, evidence });
  }
  return out.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}
