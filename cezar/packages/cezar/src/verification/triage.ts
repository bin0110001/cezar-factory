import type { VerificationRun } from '@open-mercato/cezar-contract';
import type { BaselineComparison } from './baseline.ts';
import type { FindingOccurrence, VerificationFinding } from './finding-ledger.ts';
import type { VerificationSelection } from './selection.ts';
import { sanitizeVerificationText } from './executor.ts';

const MAX_CONTEXT_CHARS = 6_000;
const MAX_FINDINGS = 10;
const MAX_DEFERRED = 8;

/** Build bounded repair context from structured evidence; raw multi-check output never enters the agent prompt. */
export function verificationTriage(input: {
  run: VerificationRun;
  selection: VerificationSelection;
  occurrences: FindingOccurrence[];
  findings: VerificationFinding[];
  comparison?: BaselineComparison;
  resultPath: string;
  root?: string;
}): string {
  const lines = [
    `Verification ${input.run.status} (run ${input.run.cezarRunId}, verification ${input.run.verificationId}, commit ${input.run.commitSha.slice(0, 12)}).`,
    `Coverage: ${input.run.coverage.passed}/${input.run.coverage.selected} selected checks passed; ${input.run.coverage.failed} failed, ${input.run.coverage.unknown} inconclusive.`,
  ];
  const comparison = input.comparison;
  if (comparison) {
    lines.push(`Policy ${comparison.mode}: ${Object.entries(comparison.counts).filter(([, count]) => count).map(([kind, count]) => `${kind}=${count}`).join(', ') || 'no findings'}; progress ${comparison.developmentProgressAllowed ? 'allowed' : 'blocked'}, green ${comparison.verificationGreen ? 'yes' : 'no'}, release ${comparison.releaseReady ? 'ready' : 'blocked'}.`);
    for (const reason of comparison.reasons.slice(0, 3)) lines.push(`Policy detail: ${reason.slice(0, 240)}`);
  }
  const failures = input.run.checks.filter((check) => ['failed', 'unknown', 'infrastructure-error', 'cancelled', 'no-tests', 'skipped'].includes(check.status));
  if (failures.length) lines.push('Checks requiring attention:');
  const findingsByFingerprint = new Map(input.findings.flatMap((finding) => [
    [finding.fingerprint, finding] as const,
    ...finding.aliases.map((alias) => [alias, finding] as const),
  ]));
  const occurrences = new Map<string, FindingOccurrence>();
  for (const occurrence of input.occurrences) if (occurrence.verificationId === input.run.verificationId) occurrences.set(occurrence.fingerprint, occurrence);
  const comparisonByFinding = new Map((comparison?.outcomes ?? []).filter((item) => item.fingerprint).map((item) => [item.fingerprint!, item.kind]));
  let emitted = 0;
  for (const check of failures) {
    lines.push(`- ${check.checkId}: ${check.status}${check.rawExitCode === null ? '' : ` (exit ${check.rawExitCode})`}${check.outputTruncated ? '; output truncated' : ''}.`);
    const related = [...occurrences.values()].filter((item) => item.checkId === check.checkId).slice(0, 3);
    for (const occurrence of related) {
      if (emitted >= MAX_FINDINGS) break;
      const finding = findingsByFingerprint.get(occurrence.fingerprint);
      const episode = finding?.episodes.find((item) => item.id === occurrence.episodeId);
      const classification = comparisonByFinding.get(occurrence.fingerprint) ?? (finding?.status === 'resolved' ? 'reopened' : 'recorded');
      const where = occurrence.file ? ` at ${occurrence.file}${occurrence.line ? `:${occurrence.line}` : ''}` : '';
      const episodeOccurrences = input.occurrences.filter((item) => item.findingId === occurrence.findingId && item.episodeId === occurrence.episodeId).length;
      const repeat = episode ? `; episode ${episode.number}${episode.number > 1 || episodeOccurrences > 1 ? `, seen ${episodeOccurrences} times` : ''}` : '';
      const safeMessage = input.root ? sanitizeVerificationText(occurrence.message, input.root) : occurrence.message;
      lines.push(`  ${classification} ${occurrence.fingerprint.slice(0, 12)} [${occurrence.code}]${where}${repeat}: ${safeMessage.slice(0, 300)}`);
      emitted++;
    }
    if (!related.length && check.outputPreview.trim()) lines.push(`  ${check.outputPreview.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const deferred = input.selection.checks.filter((check) => check.status === 'deferred');
  if (deferred.length) lines.push(`Deferred checks (${deferred.length}): ${deferred.slice(0, MAX_DEFERRED).map((check) => `${check.checkId} — ${check.reason}`).join('; ')}${deferred.length > MAX_DEFERRED ? '; more in selection details' : ''}.`);
  const details = `Details: ${input.resultPath}; selection: ${input.run.artifacts[0]?.path ?? 'see verification result'}.`;
  const body = lines.join('\n');
  if (body.length + details.length + 1 <= MAX_CONTEXT_CHARS) return `${body}\n${details}`;
  return `${body.slice(0, MAX_CONTEXT_CHARS - details.length - 42)}\n[triage summary truncated]\n${details}`;
}

export function verificationRetryCheckIds(run: VerificationRun, comparison?: BaselineComparison): string[] {
  const ids = new Set(run.checks.filter((check) => check.status === 'failed').map((check) => check.checkId));
  for (const outcome of comparison?.outcomes ?? []) {
    if (['new', 'worsening', 'reopened'].includes(outcome.kind) && outcome.checkId !== '*') ids.add(outcome.checkId);
  }
  return [...ids].sort();
}

export function historicalVerificationRetryCheckIds(runId: string, occurrences: FindingOccurrence[], findings: VerificationFinding[]): string[] {
  const openFindingIds = new Set(findings.filter((finding) => finding.status === 'open' && !finding.canonicalId).map((finding) => finding.id));
  return [...new Set(occurrences.filter((occurrence) => occurrence.runId === runId && openFindingIds.has(occurrence.findingId)).map((occurrence) => occurrence.checkId))].sort();
}

