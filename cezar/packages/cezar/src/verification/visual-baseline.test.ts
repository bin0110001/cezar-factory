import { describe, expect, it } from 'vitest';
import {
  authorizeChange, compareVisual, genericVisualAdapter, playwrightSnapshotAdapter, policySha256, relaxesPolicy,
  selectBaseline, type BaselineRecord, type RawImage, type RendererFingerprint, type VisualPolicy,
} from './visual-baseline.ts';

const renderer = (over: Partial<RendererFingerprint> = {}): RendererFingerprint => ({
  os: 'linux', resolution: { width: 4, height: 4 }, dpi: 96, displayBackend: 'xvfb', renderer: 'software',
  graphicsApi: 'opengl', driver: 'llvmpipe', appVersion: '1.0.0', colorSettings: { gamma: '2.2' }, renderFeatures: ['aa'], ...over,
});
const image = (fill = 10): RawImage => ({ width: 4, height: 4, data: new Uint8Array(64).fill(fill) });
const policy = (over: Partial<VisualPolicy> = {}): VisualPolicy => ({ version: 1, channelTolerance: 0, maxDiffRatio: 0, masks: [], maxMaskedRatio: 0.25, ...over });
const baseline = (p: VisualPolicy, over: Partial<BaselineRecord> = {}): BaselineRecord => ({
  baselineId: 'b1', image: image(), renderer: renderer(), commitSha: 'a'.repeat(40), changeReason: 'initial',
  approvedBy: 'rev', approvedAt: '2026-11-01T00:00:00Z', policySha256: policySha256(p), ...over,
});

describe('visual baseline comparison', () => {
  it('is stable on repeat runs and fails a real pixel change', () => {
    const p = policy();
    const b = baseline(p);
    for (let i = 0; i < 3; i++) expect(compareVisual({ actual: image(), actualRenderer: renderer(), candidates: [b], policy: p }).status).toBe('passed');
    const changed = image(); changed.data[0] = 200;
    expect(compareVisual({ actual: changed, actualRenderer: renderer(), candidates: [b], policy: p }).status).toBe('failed');
  });

  it('is inconclusive without a baseline or on an incompatible GPU/driver', () => {
    const p = policy();
    expect(compareVisual({ actual: image(), actualRenderer: renderer(), candidates: [], policy: p }).status).toBe('inconclusive');
    const gpu = renderer({ renderer: 'vulkan', driver: 'nvidia-555' });
    const r = compareVisual({ actual: image(), actualRenderer: gpu, candidates: [baseline(p)], policy: p });
    expect(r.status).toBe('inconclusive');
    expect(r.rendererMismatch).toEqual(expect.arrayContaining(['renderer', 'driver']));
  });

  it('selects a compatible baseline among several, newest first', () => {
    const p = policy();
    const old = baseline(p, { baselineId: 'old', approvedAt: '2026-10-01T00:00:00Z' });
    const gpu = baseline(p, { baselineId: 'gpu', renderer: renderer({ driver: 'nvidia' }), approvedAt: '2026-11-05T00:00:00Z' });
    const sel = selectBaseline([old, gpu], renderer());
    expect(sel.kind === 'selected' && sel.baseline.baselineId).toBe('old');
  });

  it('masks hide only their region; changes outside still fail and unbounded masks are rejected', () => {
    const mask = { x: 0, y: 0, width: 2, height: 2, reason: 'clock', approvedBy: 'rev' };
    const p = policy({ masks: [mask] });
    const b = baseline(p);
    const inMask = image(); inMask.data[0] = 255;
    expect(compareVisual({ actual: inMask, actualRenderer: renderer(), candidates: [b], policy: p }).status).toBe('passed');
    const outside = image(); outside.data[(3 * 4 + 3) * 4] = 255;
    expect(compareVisual({ actual: outside, actualRenderer: renderer(), candidates: [b], policy: p }).status).toBe('failed');
    const huge = policy({ masks: [{ ...mask, width: 4, height: 4 }] });
    expect(compareVisual({ actual: image(), actualRenderer: renderer(), candidates: [baseline(huge)], policy: huge }).status).toBe('inconclusive');
    const oob = policy({ masks: [{ ...mask, x: 3, width: 2 }] });
    expect(compareVisual({ actual: image(), actualRenderer: renderer(), candidates: [baseline(oob)], policy: oob }).status).toBe('inconclusive');
  });

  it('refuses a policy that differs from the approved one', () => {
    const b = baseline(policy());
    const loose = policy({ channelTolerance: 255, maxDiffRatio: 1 });
    expect(compareVisual({ actual: image(1), actualRenderer: renderer(), candidates: [b], policy: loose }).status).toBe('inconclusive');
  });

  it('requires a distinct permitted reviewer to relax policy or replace a baseline', () => {
    const cur = policy();
    const loose = policy({ maxDiffRatio: 0.5 });
    const cfg = { reviewers: ['rev'], requireSignOff: true };
    expect(relaxesPolicy(cur, loose)).toBe(true);
    expect(authorizeChange({ requestedBy: 'agent', kind: 'policy', current: cur, proposed: loose }, cfg).allowed).toBe(false);
    expect(authorizeChange({ requestedBy: 'agent', kind: 'policy', current: cur, proposed: loose, signOff: { reviewer: 'agent', at: 'x' } }, cfg).allowed).toBe(false);
    expect(authorizeChange({ requestedBy: 'agent', kind: 'policy', current: cur, proposed: loose, signOff: { reviewer: 'other', at: 'x' } }, cfg).allowed).toBe(false);
    expect(authorizeChange({ requestedBy: 'agent', kind: 'policy', current: cur, proposed: loose, signOff: { reviewer: 'rev', at: 'x' } }, cfg).allowed).toBe(true);
    expect(authorizeChange({ requestedBy: 'agent', kind: 'policy', current: loose, proposed: cur }, cfg).allowed).toBe(true);
    expect(authorizeChange({ requestedBy: 'agent', kind: 'baseline', current: cur, proposed: cur, replacesApprovedBaseline: true }, cfg).allowed).toBe(false);
  });

  it('adapters share one baseline key scheme', () => {
    expect(playwrightSnapshotAdapter.baselineKey({ testId: 't', name: 'home.png', project: 'chromium' })).toBe('playwright/chromium/t/home.png');
    expect(genericVisualAdapter.baselineKey({ testId: 't', name: 'menu' })).toBe('generic/t/menu');
  });
});
