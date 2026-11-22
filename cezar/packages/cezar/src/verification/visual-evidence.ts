import { verificationEvidenceResponseSchema, type VerificationEvidenceResponse, type VerificationRun } from '@open-mercato/cezar-contract';
import type { ProjectContext } from '../server/project-context.ts';
import { artifactRefs, readHistory, readRecordedBytes, type HistoryRecord } from './history.ts';
import { rendererMismatch, type RendererFingerprint } from './visual-baseline.ts';

/** Largest media served inline; larger evidence is download-only so a preview stays bounded. */
export const EVIDENCE_PREVIEW_MAX_BYTES = 1_048_576;
export const EVIDENCE_DOWNLOAD_MAX_BYTES = 52_428_800;

export interface EvidenceViewer {
  /** True only for the local operator surface; every other caller is a project reader. */
  localOperator: boolean;
}

type Item = VerificationEvidenceResponse['groups'][number]['items'][number];
type Check = VerificationRun['checks'][number];
type Outcome = 'passed' | 'failed' | 'incomplete' | 'inconclusive';

/**
 * Access matrix, applied separately to metadata, preview and download:
 * - `private` evidence is invisible (not even listed) to anyone but the local operator.
 * - Only `redacted` media is previewable. `unredacted` (possibly licensed) media is never previewed and is
 *   downloadable by the local operator only. `unknown` redaction is treated as unsafe: never served.
 */
function access(evidence: NonNullable<HistoryRecord['result']['checks'][number]['artifacts'][number]['visualEvidence']>, mediaType: string, bytes: number, viewer: EvidenceViewer) {
  const visible = evidence.accessPolicy !== 'private' || viewer.localOperator;
  const redacted = evidence.redactionState === 'redacted';
  const imageKind = evidence.kind === 'png' || evidence.kind === 'jpeg' || evidence.kind === 'diff';
  const preview: Item['preview'] = !visible || !redacted ? 'denied'
    : imageKind && mediaType === 'image/png' && bytes <= EVIDENCE_PREVIEW_MAX_BYTES ? 'available' : 'unsupported';
  const download: Item['download'] = visible && bytes <= EVIDENCE_DOWNLOAD_MAX_BYTES
    && (redacted || (evidence.redactionState === 'unredacted' && viewer.localOperator)) ? 'available' : 'denied';
  return { visible, preview, download };
}

function sideOf(kind: Item['kind'], role: string): Item['side'] {
  if (kind === 'diff') return 'diff';
  if (role === 'expected' || role === 'baseline') return 'expected';
  if (role === 'actual') return 'actual';
  return 'other';
}

const rank: Record<Outcome, number> = { failed: 3, incomplete: 2, inconclusive: 1, passed: 0 };

function groupFor(check: Check, record: HistoryRecord, viewer: EvidenceViewer, required: string[], stale: boolean) {
  const refs = artifactRefs(record).filter((entry) => check.artifacts.includes(entry.ref) && entry.ref.visualEvidence);
  const items: Item[] = [];
  const renderers = new Map<string, RendererFingerprint>();
  let withheld = 0;
  const recordedRoles = new Set<string>();
  const sides = new Set<Item['side']>();
  for (const { ref, id } of refs) {
    const evidence = ref.visualEvidence!;
    recordedRoles.add(evidence.role);
    const side = sideOf(evidence.kind, evidence.role);
    sides.add(side);
    renderers.set(`${side}:${evidence.role}`, evidence.renderer);
    const verdict = access(evidence, ref.mediaType, ref.bytes, viewer);
    if (!verdict.visible) { withheld += 1; continue; }
    items.push({
      id, kind: evidence.kind, side, role: evidence.role, sessionId: evidence.sessionId, attempt: evidence.attempt,
      capturedAt: evidence.capturedAt, mediaType: ref.mediaType, bytes: ref.bytes, sha256: ref.sha256,
      accessPolicy: evidence.accessPolicy, redactionState: evidence.redactionState, retention: evidence.retention,
      preview: verdict.preview, download: verdict.download,
      renderer: { os: evidence.renderer.os, renderer: evidence.renderer.renderer, displayBackend: evidence.renderer.displayBackend, appVersion: evidence.renderer.appVersion },
    });
  }
  items.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
  const roles = [...recordedRoles].sort();
  const missingRoles = required.filter((role) => !recordedRoles.has(role));
  const expected = [...renderers].find(([key]) => key.startsWith('expected:'))?.[1];
  const actual = [...renderers].find(([key]) => key.startsWith('actual:'))?.[1];
  const mismatch = expected && actual ? rendererMismatch(expected, actual) : [];

  let outcome: Outcome;
  let reason: string;
  const captures = refs.filter(({ ref }) => ref.visualEvidence!.kind === 'png' || ref.visualEvidence!.kind === 'jpeg' || ref.visualEvidence!.kind === 'video').length;
  if (stale) { outcome = 'inconclusive'; reason = 'evidence belongs to a different revision than the one requested'; }
  else if (check.status === 'failed') { outcome = 'failed'; reason = 'the visual check failed'; }
  else if (check.status !== 'passed') { outcome = 'inconclusive'; reason = `the check ended ${check.status}; no verdict can be drawn`; }
  else if (captures === 0) { outcome = 'incomplete'; reason = 'no capture was recorded'; }
  else if (missingRoles.length > 0) { outcome = 'incomplete'; reason = `missing capture for role ${missingRoles.join(', ')}`; }
  else if (sides.has('expected') && !sides.has('actual')) { outcome = 'incomplete'; reason = 'a baseline exists but no actual capture was recorded'; }
  else if (mismatch.length > 0) { outcome = 'inconclusive'; reason = `baseline is not comparable: renderer differs in ${mismatch.join(', ')}`; }
  else { outcome = 'passed'; reason = 'recorded captures are complete and the check passed'; }
  return { testId: check.checkId, outcome, reason, checkStatus: check.status, roles, missingRoles, rendererMismatch: mismatch, items, withheld };
}

/** Revision-bound visual evidence for one verification run. Missing evidence is never a pass. */
export async function readVerificationEvidence(
  context: ProjectContext,
  verificationId: string,
  viewer: EvidenceViewer,
  query: { commitSha?: string; roles?: string } = {},
): Promise<VerificationEvidenceResponse | undefined> {
  const record = (await readHistory(context)).find((item) => item.result.verificationId === verificationId);
  if (!record) return undefined;
  const run = record.result;
  const required = (query.roles ?? '').split(',').map((role) => role.trim()).filter(Boolean);
  const stale = query.commitSha !== undefined && query.commitSha.toLowerCase() !== run.commitSha.toLowerCase();
  const visualChecks = run.checks.filter((check) => check.artifacts.some((artifact) => artifact.visualEvidence));
  const groups = visualChecks.map((check) => groupFor(check, record, viewer, required, stale));
  const outcome = groups.length === 0 ? null : groups.reduce<Outcome>((worst, group) => rank[group.outcome] > rank[worst] ? group.outcome : worst, 'passed');
  const policyVersions = [...new Set(visualChecks.flatMap((check) => check.artifacts.flatMap((artifact) => artifact.visualEvidence ? [artifact.visualEvidence.policyVersion] : [])))].sort();
  const timeline = groups.flatMap((group) => group.items.map((item) => ({ capturedAt: item.capturedAt, testId: group.testId, role: item.role, sessionId: item.sessionId, itemId: item.id, kind: item.kind })))
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.role.localeCompare(b.role) || a.itemId.localeCompare(b.itemId));
  return verificationEvidenceResponseSchema.parse({
    schemaVersion: 1, verificationId: run.verificationId, commitSha: run.commitSha, manifestSha256: run.manifestSha256,
    policyVersions, state: groups.length === 0 ? 'none' : stale ? 'stale' : 'current', outcome, groups, timeline,
  });
}

export type EvidenceContentResult =
  | { status: 200; bytes: Buffer; contentType: string; filename: string }
  | { status: 403 | 404 | 409 | 410 | 413 | 415 };

/** Serve one evidence item. Each read re-checks access, redaction, size and the recorded digest. */
export async function readEvidenceContent(
  context: ProjectContext,
  verificationId: string,
  artifactId: string,
  disposition: 'preview' | 'download',
  viewer: EvidenceViewer,
): Promise<EvidenceContentResult> {
  const record = (await readHistory(context)).find((item) => item.result.verificationId === verificationId);
  const entry = record && artifactRefs(record).find((item) => item.id === artifactId && item.ref.visualEvidence);
  if (!record || !entry) return { status: 404 };
  const evidence = entry.ref.visualEvidence!;
  const verdict = access(evidence, entry.ref.mediaType, entry.ref.bytes, viewer);
  if (!verdict.visible) return { status: 404 }; // do not confirm that private evidence exists
  if (disposition === 'preview') {
    if (verdict.preview === 'denied') return { status: 403 };
    if (verdict.preview === 'unsupported') return { status: entry.ref.bytes > EVIDENCE_PREVIEW_MAX_BYTES ? 413 : 415 };
  } else if (verdict.download === 'denied') return { status: 403 };
  const read = await readRecordedBytes(context, record, entry.ref.path, entry.ref.sha256);
  if (read.status !== 200) return { status: read.status };
  const safeName = `${evidence.testId}-${evidence.role}-${evidence.kind}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return disposition === 'preview'
    ? { status: 200, bytes: read.bytes, contentType: 'image/png', filename: `${safeName}.png` }
    : { status: 200, bytes: read.bytes, contentType: 'application/octet-stream', filename: safeName };
}
