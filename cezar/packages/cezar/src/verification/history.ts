import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  VERIFICATION_LIMITS,
  verificationArtifactContentSchema,
  verificationQueryWireSchema,
  verificationRunSchema,
  type VerificationQueryInput,
  type VerificationRun,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunEvent, RunRecord } from '../runs/store.ts';
import { getCodingRunSnapshot } from '../workspace/lifecycle.ts';
import { verifyCodingAttemptManifest } from '../workspace/coding-run-manifest.ts';

const INLINE_BYTES = 2_048;
const EXCERPT_CHARS = 512;
const MAX_RESPONSE_BYTES = 262_144;
const ARTIFACT_CONTENT_BYTES = 65_536;
const REDACTED = '[REDACTED]';

interface Selection { suite: string; selected: Array<{ testId: string; reason: string }>; deferred: Array<{ testId: string; reason: string }> }
interface CodingEvidenceSummary {
  status: 'available' | 'not-recorded' | 'unavailable';
  attempts: Array<{ attemptId: string; index: number; status: string; manifestStatus: 'not-recorded' | 'verified' | 'tampered' | 'invalid'; manifestDigest?: string; manifestReference: string; artifactCount: number }>;
}
interface HistoryRecord { owner: RunRecord; event: RunEvent; result: VerificationRun; selection: Selection; codingEvidence: CodingEvidenceSummary }
interface QueryItem { key: { startedAt: string; runId: string; itemId: string }; body: Record<string, unknown> }

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function stableArtifactId(verificationId: string, path: string): string {
  return `${verificationId}-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
}

function selectionFrom(value: unknown): Selection {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const suite = typeof candidate.suite === 'string' ? candidate.suite.slice(0, 128) : 'unknown';
  const entries = (input: unknown) => Array.isArray(input) ? input.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    return typeof row.testId === 'string' && typeof row.reason === 'string'
      ? [{ testId: row.testId.slice(0, 128), reason: row.reason.slice(0, 16_384) }]
      : [];
  }) : [];
  return { suite, selected: entries(candidate.selected), deferred: entries(candidate.deferred) };
}

async function legacyResult(context: ProjectContext, owner: RunRecord, event: RunEvent): Promise<VerificationRun | undefined> {
  if (typeof event.artifactPath !== 'string' || event.artifactPath.includes('\\') || event.artifactPath.startsWith('/')) return undefined;
  const parts = event.artifactPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return undefined;
  const root = owner.worktreePath && existsSync(owner.worktreePath) ? owner.worktreePath : owner.worktree === false ? context.root : undefined;
  if (!root) return undefined;
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(resolve(realRoot, ...parts));
    if (!inside(realRoot, realFile)) return undefined;
    const bytes = await readFile(realFile);
    if (bytes.byteLength > VERIFICATION_LIMITS.resultBytes) return undefined;
    const parsed = verificationRunSchema.safeParse(JSON.parse(bytes.toString('utf8')) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

async function readHistory(context: ProjectContext): Promise<HistoryRecord[]> {
  const output: HistoryRecord[] = [];
  const evidenceByRun = new Map<string, CodingEvidenceSummary>();
  for (const owner of context.store.listRuns()) {
    for (const event of context.store.readEvents(owner.id)) {
      if (event.type !== 'verification-result') continue;
      const parsed = verificationRunSchema.safeParse(event.result);
      const result = parsed.success ? parsed.data : await legacyResult(context, owner, event);
      if (result) {
        const cezarRunId = result.cezarRunId ?? owner.id;
        let codingEvidence = evidenceByRun.get(cezarRunId);
        if (!codingEvidence) {
          try {
            const snapshot = await getCodingRunSnapshot({ runId: cezarRunId, cwd: context.root });
            codingEvidence = snapshot ? {
              status: 'available',
              attempts: snapshot.attempts.map((attempt) => {
                const verification = attempt.manifest ? verifyCodingAttemptManifest(attempt.manifest) : undefined;
                return {
                  attemptId: attempt.attemptId, index: attempt.index, status: attempt.status,
                  manifestStatus: !attempt.manifest ? 'not-recorded' as const
                    : verification?.status === 'valid' ? 'verified' as const
                      : verification?.status === 'tampered' ? 'tampered' as const : 'invalid' as const,
                  ...(attempt.manifest ? { manifestDigest: attempt.manifest.manifestDigest } : {}),
                  manifestReference: `coding-run:${cezarRunId}/attempts/${attempt.attemptId}/manifest`,
                  artifactCount: attempt.manifest?.artifacts.length ?? 0,
                };
              }),
            } : { status: 'not-recorded', attempts: [] };
          } catch { codingEvidence = { status: 'unavailable', attempts: [] }; }
          evidenceByRun.set(cezarRunId, codingEvidence);
        }
        output.push({ owner, event, result, selection: selectionFrom(event.selection), codingEvidence });
      }
    }
  }
  output.sort((a, b) => b.result.startedAt.localeCompare(a.result.startedAt)
    || a.result.verificationId.localeCompare(b.result.verificationId));
  return output;
}

function bounded(text: string, reference: string) {
  const bytes = Buffer.byteLength(text, 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  const safe = safeText(text);
  const truncated = bytes > INLINE_BYTES;
  return {
    bytes, sha256, truncated,
    content: truncated ? null : safe,
    head: truncated ? safe.slice(0, EXCERPT_CHARS) : null,
    tail: truncated ? safe.slice(-EXCERPT_CHARS) : null,
    reference,
  };
}

function safeText(text: string): string {
  const secrets = collectSecretValues();
  let safe = text;
  safe = safe.replace(/(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`);
  safe = safe.replace(/(\b(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1${REDACTED}`);
  safe = safe.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, `$1${REDACTED}@`);
  safe = safe.replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, `-----BEGIN $1-----${REDACTED}-----END $1-----`);
  return redactSecrets(safe, secrets);
}

function safeMetrics(metrics: VerificationRun['checks'][number]['metrics']) {
  return metrics.map((metric) => ({
    name: safeText(metric.name),
    value: metric.value,
    ...(metric.unit ? { unit: safeText(metric.unit) } : {}),
    ...(metric.samples ? { samples: metric.samples } : {}),
    ...(metric.method ? { method: safeText(metric.method) } : {}),
  }));
}

function artifactRefs(record: HistoryRecord) {
  const refs = [...record.result.artifacts, ...record.result.checks.flatMap((check) => check.artifacts)];
  return refs.map((ref) => ({ ref, id: stableArtifactId(record.result.verificationId, ref.path) }));
}

function queryKey(item: QueryItem): string { return `${item.key.startedAt}\0${item.key.runId}\0${item.key.itemId}`; }

function cursorEncode(key: { startedAt: string; runId: string; itemId: string }, queryHash: string): string {
  return Buffer.from(JSON.stringify({ v: 1, queryHash, after: key })).toString('base64url');
}

function cursorDecode(cursor: string, queryHash: string): { startedAt: string; runId: string; itemId: string } | 'invalid_cursor' | 'stale_cursor' {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.queryHash !== 'string' || !value.after || typeof value.after !== 'object') return 'invalid_cursor';
    if (value.queryHash !== queryHash) return 'stale_cursor';
    const after = value.after as Record<string, unknown>;
    if (typeof after.startedAt !== 'string' || typeof after.runId !== 'string' || typeof after.itemId !== 'string') return 'invalid_cursor';
    return after as { startedAt: string; runId: string; itemId: string };
  } catch { return 'invalid_cursor'; }
}

function compareKey(a: QueryItem['key'], b: QueryItem['key']): number {
  const time = b.startedAt.localeCompare(a.startedAt);
  if (time) return time;
  const run = a.runId.localeCompare(b.runId);
  return run || a.itemId.localeCompare(b.itemId);
}

function episodeRows(all: HistoryRecord[], forRun?: string) {
  const seen = new Map<string, Array<{ run: HistoryRecord; checkId: string }>>();
  for (const run of all) for (const check of run.result.checks) {
    if (check.status !== 'failed' || !check.findingFingerprint) continue;
    const list = seen.get(check.findingFingerprint) ?? [];
    list.push({ run, checkId: check.checkId });
    seen.set(check.findingFingerprint, list);
  }
  return [...seen.entries()].flatMap(([fingerprint, occurrences]) => {
    occurrences.sort((a, b) => a.run.result.startedAt.localeCompare(b.run.result.startedAt)
      || a.run.result.verificationId.localeCompare(b.run.result.verificationId));
    const first = occurrences[0]!;
    const last = occurrences[occurrences.length - 1]!;
    const latestSameCheck = all.flatMap((run) => run.result.checks.filter((check) => check.checkId === last.checkId).map((check) => ({ run, check })))
      .sort((a, b) => b.run.result.startedAt.localeCompare(a.run.result.startedAt)
        || b.run.result.verificationId.localeCompare(a.run.result.verificationId))[0];
    const currentIds = forRun ? new Set(all.filter((run) => run.result.verificationId === forRun).flatMap((run) => run.result.checks.map((check) => check.findingFingerprint))) : undefined;
    if (currentIds && !currentIds.has(fingerprint)) return [];
    return [{
      runId: last.run.result.verificationId, id: fingerprint, fingerprint,
      status: latestSameCheck && latestSameCheck.check.status === 'passed' && latestSameCheck.run.result.startedAt > last.run.result.startedAt ? 'resolved' : 'open', firstSeenAt: first.run.result.startedAt,
      lastSeenAt: last.run.result.startedAt, occurrences: occurrences.length,
    }];
  });
}

function makeItems(all: HistoryRecord[], query: VerificationQueryInput): QueryItem[] {
  const records = query.runId ? all.filter((record) => record.result.verificationId === query.runId) : all;
  const entries: QueryItem[] = [];
  const add = (record: HistoryRecord, itemId: string, body: Record<string, unknown>) => {
    if (query.status && String(body.status ?? '') !== query.status) return;
    entries.push({ key: { startedAt: record.result.startedAt, runId: record.result.verificationId, itemId }, body });
  };
  const episodes = episodeRows(all, query.runId);
  for (const record of records) {
    const result = record.result;
    const refs = artifactRefs(record);
    if (query.kind === 'runs') {
      add(record, result.verificationId, {
        id: result.verificationId, startedAt: result.startedAt, finishedAt: result.finishedAt, status: result.status,
        commitSha: result.commitSha, baseSha: result.baseSha ?? '', baselineRunId: null,
        cezarRunId: result.cezarRunId,
        projectId: result.projectId,
        ...(record.owner.referencedIssueUrl?.startsWith('https://github.com/') ? { githubIssueUrl: record.owner.referencedIssueUrl } : {}),
        environment: Object.fromEntries(Object.entries(result.environment).map(([key, value]) => [safeText(key), safeText(value)])),
        coverage: result.coverage,
        suite: record.selection.suite,
        counts: {
          selected: record.selection.selected.length || result.checks.filter((check) => check.status !== 'not-selected').length,
          deferred: record.selection.deferred.length, failures: result.checks.filter((check) => check.status === 'failed').length,
          episodes: new Set(result.checks.flatMap((check) => check.findingFingerprint ? [check.findingFingerprint] : [])).size,
          artifacts: refs.length,
        },
        checks: result.checks.map((check) => ({ checkId: check.checkId, status: check.status, durationMs: check.durationMs, metrics: safeMetrics(check.metrics), ...(check.findingFingerprint ? { findingFingerprint: check.findingFingerprint } : {}) })),
        codingEvidence: record.codingEvidence,
      });
    } else if (query.kind === 'selected' || query.kind === 'deferred') {
      const selected = query.kind === 'selected';
      for (const item of selected ? record.selection.selected : record.selection.deferred) {
        add(record, item.testId, { runId: result.verificationId, testId: item.testId, reason: bounded(item.reason, `run:${result.verificationId}/${query.kind}/${item.testId}`) });
      }
    } else if (query.kind === 'failures') {
      for (const check of result.checks.filter((value) => value.status === 'failed')) {
        const fingerprint = check.findingFingerprint;
        const occurrenceCount = fingerprint ? episodeRows(all).find((item) => item.fingerprint === fingerprint)?.occurrences ?? 0 : 0;
        const message = check.diagnostics.map((diagnostic) => diagnostic.message).filter(Boolean).join('\n') || check.checkId;
        add(record, check.checkId, {
          runId: result.verificationId, id: `${check.checkId}:${check.attempt}`, testId: check.checkId, status: check.status,
          message: bounded(message, `run:${result.verificationId}/failures/${check.checkId}`),
          output: bounded(check.outputPreview, `run:${result.verificationId}/failures/${check.checkId}/output`),
          classification: fingerprint ? occurrenceCount > 1 ? 'known' : 'new' : 'unknown',
          ...(fingerprint ? { episodeId: fingerprint } : {}),
        });
      }
    } else if (query.kind === 'artifacts') {
      for (const { ref, id } of refs) {
        add(record, id, { runId: result.verificationId, id, name: safeText(ref.path.split('/').at(-1) ?? ref.path), path: safeText(ref.path), mediaType: ref.mediaType,
          data: { bytes: ref.bytes, sha256: ref.sha256, truncated: true, content: null, head: null, tail: null, reference: `run:${result.verificationId}/artifacts/${id}` } });
      }
    } else if (query.kind === 'baseline') {
      // Baselines are not stored by this executor. The shared query kind remains empty until a
      // producer supplies a comparison, rather than inventing a baseline from adjacent runs.
    }
  }
  if (query.kind === 'episodes') for (const episode of episodes) {
    const record = all.find((item) => item.result.verificationId === episode.runId);
    if (record && (!query.status || episode.status === query.status)) entries.push({ key: { startedAt: episode.lastSeenAt, runId: episode.runId, itemId: episode.id }, body: episode });
  }
  return entries.sort((a, b) => compareKey(a.key, b.key));
}

export async function queryVerificationHistory(context: ProjectContext, query: VerificationQueryInput) {
  const all = await readHistory(context);
  const items = makeItems(all, query);
  const queryHash = createHash('sha256').update(JSON.stringify({ kind: query.kind, runId: query.runId ?? '', status: query.status ?? '' })).digest('hex');
  let after: { startedAt: string; runId: string; itemId: string } | undefined;
  if (query.cursor) {
    const decoded = cursorDecode(query.cursor, queryHash);
    if (typeof decoded === 'string') return { schemaVersion: 1 as const, error: { code: decoded, message: decoded === 'invalid_cursor' ? 'Cursor is malformed.' : 'Cursor belongs to another query or is stale.' } };
    const cursorAfter = decoded;
    if (!items.some((item) => queryKey(item) === `${cursorAfter.startedAt}\0${cursorAfter.runId}\0${cursorAfter.itemId}`)) return { schemaVersion: 1 as const, error: { code: 'stale_cursor' as const, message: 'Cursor points to an item that is no longer in this result set.' } };
    after = cursorAfter;
  }
  const remaining = after ? items.filter((item) => compareKey(item.key, after!) > 0) : items;
  let page = remaining.slice(0, query.pageSize);
  const build = (rows: QueryItem[], hasMore: boolean) => ({
    schemaVersion: 1 as const, kind: query.kind,
    query: { runId: query.runId ?? '', status: query.status ?? '', pageSize: query.pageSize },
    items: rows.map((item) => item.body),
    page: { returned: rows.length, hasMore, nextCursor: hasMore && rows.length ? cursorEncode(rows[rows.length - 1]!.key, queryHash) : null },
    limits: { inlineBytes: INLINE_BYTES, excerptChars: EXCERPT_CHARS, maxResponseBytes: MAX_RESPONSE_BYTES },
  });
  let result = build(page, page.length < remaining.length);
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES && page.length > 1) {
    page = page.slice(0, -1);
    result = build(page, true);
  }
  return verificationQueryWireSchema.parse(result);
}

/** Resolve the query's content reference to the immutable manifest; tampering is a conflict, never a pass. */
export async function readCodingAttemptManifest(context: ProjectContext, runId: string, attemptId: string) {
  let snapshot;
  try { snapshot = await getCodingRunSnapshot({ runId, cwd: context.root }); }
  catch { return { status: 409 as const, body: { status: 'unavailable' as const } }; }
  const attempt = snapshot?.attempts.find((item) => item.attemptId === attemptId);
  if (!attempt?.manifest) return { status: 404 as const };
  const verified = verifyCodingAttemptManifest(attempt.manifest);
  if (verified.status !== 'valid') return { status: 409 as const, body: { status: verified.status, ...(verified.status === 'tampered' ? { expectedDigest: verified.expectedDigest, actualDigest: verified.actualDigest } : { detail: verified.detail }) } };
  return { status: 200 as const, body: verified.manifest };
}

export async function readVerificationArtifact(context: ProjectContext, verificationId: string, id: string) {
  const history = await readHistory(context);
  const record = history.find((item) => item.result.verificationId === verificationId);
  if (!record) return { status: 404 as const };
  const artifact = artifactRefs(record).find((item) => item.id === id);
  if (!artifact) return { status: 404 as const };
  const owner = record.owner;
  const root = owner.worktreePath && existsSync(owner.worktreePath) ? owner.worktreePath : owner.worktree === false ? context.root : undefined;
  if (!root) return { status: 410 as const };
  const parts = artifact.ref.path.split('/');
  if (artifact.ref.path.includes('\\') || artifact.ref.path.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..')) return { status: 404 as const };
  try {
    const realRoot = await realpath(root);
    const file = await realpath(resolve(realRoot, ...parts));
    if (!inside(realRoot, file)) return { status: 404 as const };
    const bytes = await readFile(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== artifact.ref.sha256) return { status: 409 as const };
    const safe = safeText(bytes.toString('utf8'));
    const bounded = Buffer.from(safe, 'utf8').subarray(0, ARTIFACT_CONTENT_BYTES).toString('utf8');
    return { status: 200 as const, body: verificationArtifactContentSchema.parse({ content: bounded, bytes: bytes.byteLength, sha256, truncated: bytes.byteLength > ARTIFACT_CONTENT_BYTES || bounded.length < safe.length }) };
  } catch { return { status: 410 as const }; }
}
