import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  verificationVisualPolicySchema,
  type VerificationVisualComparison,
  type VerificationVisualPolicy,
  verificationRendererFingerprintSchema,
} from '@open-mercato/cezar-contract';

export type RendererFingerprint = z.infer<typeof verificationRendererFingerprintSchema>;
export type VisualPolicy = VerificationVisualPolicy;

/** Decoded RGBA8 image; adapters (Playwright PNG, Godot screenshot, ...) produce this. */
export interface RawImage { width: number; height: number; data: Uint8Array }

export interface BaselineRecord {
  baselineId: string;
  image: RawImage;
  renderer: RendererFingerprint;
  commitSha: string;
  changeReason: string;
  approvedBy: string;
  approvedAt: string;
  signOff?: string;
  policySha256: string;
}

/** Adapter contract: Playwright snapshots and Godot captures share one comparison path. */
export interface VisualAdapter {
  id: string;
  baselineKey(input: { testId: string; name: string; project?: string }): string;
}

export const playwrightSnapshotAdapter: VisualAdapter = {
  id: 'playwright-snapshot',
  baselineKey: ({ testId, name, project }) => `playwright/${project ?? 'default'}/${testId}/${name}`,
};

export const genericVisualAdapter: VisualAdapter = {
  id: 'generic',
  baselineKey: ({ testId, name }) => `generic/${testId}/${name}`,
};

export function policySha256(policy: VisualPolicy): string {
  const p = verificationVisualPolicySchema.parse(policy);
  const masks = [...p.masks].sort((a, b) => a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height);
  return createHash('sha256').update(JSON.stringify({ ...p, masks })).digest('hex');
}

/** Fields that make two renderers produce comparable pixels. appVersion is deliberately excluded:
 * a new app build is exactly what a baseline exists to judge. */
export function rendererMismatch(a: RendererFingerprint, b: RendererFingerprint): string[] {
  const out: string[] = [];
  if (a.os !== b.os) out.push('os');
  if (a.resolution.width !== b.resolution.width || a.resolution.height !== b.resolution.height) out.push('resolution');
  if (a.dpi !== b.dpi) out.push('dpi');
  if (a.displayBackend !== b.displayBackend) out.push('displayBackend');
  if (a.renderer !== b.renderer) out.push('renderer');
  if (a.graphicsApi !== b.graphicsApi) out.push('graphicsApi');
  if (a.driver !== b.driver) out.push('driver');
  if (JSON.stringify(Object.entries(a.colorSettings).sort()) !== JSON.stringify(Object.entries(b.colorSettings).sort())) out.push('colorSettings');
  if (JSON.stringify([...a.renderFeatures].sort()) !== JSON.stringify([...b.renderFeatures].sort())) out.push('renderFeatures');
  return out;
}

export type BaselineSelection =
  | { kind: 'selected'; baseline: BaselineRecord }
  | { kind: 'inconclusive'; reason: string; rendererMismatch: string[] };

/** Choose the newest approved baseline whose renderer is compatible; never guess otherwise. */
export function selectBaseline(candidates: readonly BaselineRecord[], actual: RendererFingerprint): BaselineSelection {
  if (candidates.length === 0) {
    return { kind: 'inconclusive', reason: 'no baseline exists for this key (unverified)', rendererMismatch: [] };
  }
  const sorted = [...candidates].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
  for (const baseline of sorted) {
    if (rendererMismatch(baseline.renderer, actual).length === 0) return { kind: 'selected', baseline };
  }
  return {
    kind: 'inconclusive',
    reason: 'no baseline was captured on a compatible renderer (unverified)',
    rendererMismatch: rendererMismatch(sorted[0]!.renderer, actual),
  };
}

export interface MaskCheck { ok: boolean; reason?: string; maskedPixels: number }

/** Masks must be in bounds, approved, and cover a bounded share of the image. */
export function checkMasks(policy: VisualPolicy, width: number, height: number): MaskCheck {
  const covered = new Uint8Array(width * height);
  let maskedPixels = 0;
  for (const m of policy.masks) {
    if (!m.reason.trim() || !m.approvedBy.trim()) return { ok: false, reason: 'mask lacks reason or approver', maskedPixels };
    if (m.x + m.width > width || m.y + m.height > height) return { ok: false, reason: 'mask exceeds image bounds', maskedPixels };
    for (let y = m.y; y < m.y + m.height; y++) {
      for (let x = m.x; x < m.x + m.width; x++) {
        const i = y * width + x;
        if (!covered[i]) { covered[i] = 1; maskedPixels++; }
      }
    }
  }
  if (maskedPixels / (width * height) > policy.maxMaskedRatio) {
    return { ok: false, reason: 'masks cover more than the permitted share of the image', maskedPixels };
  }
  return { ok: true, maskedPixels };
}

export interface PixelDiff {
  comparedPixels: number;
  differingPixels: number;
  maskedDifferingPixels: number;
  maxChannelDelta: number;
  diff: RawImage;
}

export function diffImages(expected: RawImage, actual: RawImage, policy: VisualPolicy): PixelDiff {
  const { width, height } = expected;
  const masked = new Uint8Array(width * height);
  for (const m of policy.masks) {
    for (let y = m.y; y < m.y + m.height; y++) for (let x = m.x; x < m.x + m.width; x++) masked[y * width + x] = 1;
  }
  const diff = new Uint8Array(width * height * 4);
  let compared = 0; let differing = 0; let maskedDiffering = 0; let maxDelta = 0;
  for (let p = 0; p < width * height; p++) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(expected.data[p * 4 + c]! - actual.data[p * 4 + c]!));
    const differs = delta > policy.channelTolerance;
    if (masked[p]) {
      if (differs) maskedDiffering++;
      diff[p * 4 + 2] = 255; diff[p * 4 + 3] = 255; // masked: blue
      continue;
    }
    compared++;
    maxDelta = Math.max(maxDelta, delta);
    if (differs) { differing++; diff[p * 4] = 255; diff[p * 4 + 3] = 255; } // changed: red
  }
  return { comparedPixels: compared, differingPixels: differing, maskedDifferingPixels: maskedDiffering, maxChannelDelta: maxDelta, diff: { width, height, data: diff } };
}

export interface CompareInput {
  actual: RawImage;
  actualRenderer: RendererFingerprint;
  candidates: readonly BaselineRecord[];
  /** The policy as pinned on the protected branch, never one supplied by the project agent. */
  policy: VisualPolicy;
}

export type ComparisonOutcome = Pick<VerificationVisualComparison, 'status' | 'reason' | 'rendererMismatch' | 'metrics' | 'policySha256'> & {
  baseline?: BaselineRecord;
  diff?: RawImage;
};

const metric = (name: string, value: number, unit?: string) => ({ name, value, ...(unit ? { unit } : {}) });

export function compareVisual(input: CompareInput): ComparisonOutcome {
  const policy = verificationVisualPolicySchema.parse(input.policy);
  const hash = policySha256(policy);
  const sel = selectBaseline(input.candidates, input.actualRenderer);
  if (sel.kind === 'inconclusive') {
    return { status: 'inconclusive', reason: sel.reason, rendererMismatch: sel.rendererMismatch, metrics: [], policySha256: hash };
  }
  const { baseline } = sel;
  if (baseline.policySha256 !== hash) {
    // The baseline was approved under a different policy; relaxing/changing it needs review (see authorizeChange).
    return { status: 'inconclusive', reason: 'policy differs from the policy the baseline was approved under', rendererMismatch: [], metrics: [], policySha256: hash, baseline };
  }
  const { image: expected } = baseline;
  if (expected.width !== input.actual.width || expected.height !== input.actual.height) {
    return { status: 'failed', reason: 'image dimensions differ from baseline', rendererMismatch: [], metrics: [metric('width.delta', input.actual.width - expected.width, 'px'), metric('height.delta', input.actual.height - expected.height, 'px')], policySha256: hash, baseline };
  }
  const masks = checkMasks(policy, expected.width, expected.height);
  if (!masks.ok) {
    return { status: 'inconclusive', reason: `invalid mask policy: ${masks.reason}`, rendererMismatch: [], metrics: [], policySha256: hash, baseline };
  }
  const d = diffImages(expected, input.actual, policy);
  const ratio = d.comparedPixels === 0 ? 0 : d.differingPixels / d.comparedPixels;
  const metrics = [
    metric('pixels.compared', d.comparedPixels, 'px'),
    metric('pixels.differing', d.differingPixels, 'px'),
    metric('pixels.masked', masks.maskedPixels, 'px'),
    metric('pixels.maskedDiffering', d.maskedDifferingPixels, 'px'),
    metric('diff.ratio', ratio),
    metric('diff.maxChannelDelta', d.maxChannelDelta),
  ];
  const failed = ratio > policy.maxDiffRatio;
  return {
    status: failed ? 'failed' : 'passed',
    reason: failed ? `${d.differingPixels} unmasked pixels differ (ratio ${ratio.toFixed(6)} > ${policy.maxDiffRatio})` : 'within tolerance',
    rendererMismatch: [], metrics, policySha256: hash, baseline, diff: d.diff,
  };
}

export interface ChangeRequest {
  requestedBy: string;
  kind: 'policy' | 'baseline';
  current: VisualPolicy;
  proposed: VisualPolicy;
  /** Present when a baseline would replace an approved baseline. */
  replacesApprovedBaseline?: boolean;
  signOff?: { reviewer: string; at: string };
}

export interface ChangePolicy {
  /** Identities permitted to approve baseline/policy changes (e.g. protected reviewers). */
  reviewers: readonly string[];
  requireSignOff: boolean;
}

/** True when `proposed` is any weaker than `current`: looser tolerance/ratio, wider masks, or new masks. */
export function relaxesPolicy(current: VisualPolicy, proposed: VisualPolicy): boolean {
  if (proposed.channelTolerance > current.channelTolerance) return true;
  if (proposed.maxDiffRatio > current.maxDiffRatio) return true;
  if (proposed.maxMaskedRatio > current.maxMaskedRatio) return true;
  const key = (m: VisualPolicy['masks'][number]) => `${m.x},${m.y},${m.width},${m.height}`;
  const covers = (outer: VisualPolicy['masks'][number], inner: VisualPolicy['masks'][number]) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  return proposed.masks.some((m) => !current.masks.some((c) => key(c) === key(m) || covers(c, m)));
}

export interface ChangeDecision { allowed: boolean; reason: string }

/** The project agent (author) can tighten freely; relaxing a policy or replacing an approved
 * baseline needs a listed reviewer other than the author, and a sign-off when policy demands. */
export function authorizeChange(req: ChangeRequest, policy: ChangePolicy): ChangeDecision {
  const needsReview = req.kind === 'baseline' ? req.replacesApprovedBaseline === true : relaxesPolicy(req.current, req.proposed);
  if (!needsReview) return { allowed: true, reason: 'tightening or additive change needs no review' };
  const s = req.signOff;
  if (!s) return { allowed: false, reason: 'change requires review by a permitted reviewer' };
  if (s.reviewer === req.requestedBy) return { allowed: false, reason: 'author cannot approve their own change' };
  if (!policy.reviewers.includes(s.reviewer)) return { allowed: false, reason: 'reviewer is not permitted' };
  if (policy.requireSignOff && !s.at) return { allowed: false, reason: 'manual sign-off required' };
  return { allowed: true, reason: `approved by ${s.reviewer}` };
}
