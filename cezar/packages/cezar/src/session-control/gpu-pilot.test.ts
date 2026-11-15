import { describe, expect, it } from 'vitest';
import {
  fingerprintId, gpuPilotEnabled, runGpuPilot,
  type GpuPilotDeps, type GpuRuntimeFingerprint,
} from './gpu-pilot.js';

const fp: GpuRuntimeFingerprint = {
  device: 'AMD Radeon RX 7800', driver: 'radv 25.1.0', api: 'vulkan', apiVersion: '1.3.296',
  backend: 'radv', container: 'sha256:abc', runtime: 'podman 5.4',
};
const on = { CEZ_GRAPHICAL_SESSIONS: '1', CEZ_GRAPHICAL_GPU_PILOT: '1' };

function deps(over: Partial<GpuPilotDeps> = {}): GpuPilotDeps & { released: number } {
  const state = { released: 0 };
  return Object.assign(state, {
    env: on,
    pinned: [fp],
    probe: async () => ({ kind: 'present' as const, fingerprint: fp }),
    acquireLease: async () => ({ ok: true as const, release: () => { state.released += 1; } }),
    render: async () => ({ kind: 'rendered' as const, fingerprint: fp, frameBytes: 1024 }),
    ...over,
  });
}

describe('GPU render pilot', () => {
  it('needs both the session switch and its own gate', () => {
    expect(gpuPilotEnabled({})).toBe(false);
    expect(gpuPilotEnabled({ CEZ_GRAPHICAL_SESSIONS: '1' })).toBe(false);
    expect(gpuPilotEnabled({ CEZ_GRAPHICAL_GPU_PILOT: '1' })).toBe(false);
    expect(gpuPilotEnabled(on)).toBe(true);
  });

  it('is disabled by default and never probes or renders', async () => {
    let probed = false;
    const r = await runGpuPilot(deps({ env: {}, probe: async () => { probed = true; return { kind: 'absent' }; } }));
    expect(r).toMatchObject({ status: 'disabled', rendered: false, coverageGap: true });
    expect(probed).toBe(false);
  });

  it('reports supported only after a real render on the pinned fingerprint', async () => {
    const d = deps();
    const r = await runGpuPilot(d);
    expect(r).toEqual({ status: 'supported', rendered: true, coverageGap: false, fingerprintId: fingerprintId(fp) });
    expect(d.released).toBe(1);
  });

  it('absent GPU is an explicit gap, not a pass', async () => {
    const r = await runGpuPilot(deps({ probe: async () => ({ kind: 'absent' }) }));
    expect(r).toMatchObject({ status: 'unavailable', reason: 'gpu_unavailable', rendered: false, coverageGap: true });
  });

  it('a failing probe is stale capability', async () => {
    const r = await runGpuPilot(deps({ probe: async () => { throw new Error('x'); } }));
    expect(r).toMatchObject({ status: 'failed', reason: 'stale_capability', rendered: false });
  });

  it('software rendering is never GPU support', async () => {
    const soft = { ...fp, device: 'llvmpipe', backend: 'llvmpipe', api: 'opengl' as const };
    const r = await runGpuPilot(deps({ pinned: [soft], probe: async () => ({ kind: 'present', fingerprint: soft }) }));
    expect(r).toMatchObject({ status: 'unsupported', reason: 'unsupported_renderer', rendered: false });
  });

  it('an unpinned driver or runtime is unsupported', async () => {
    const other = { ...fp, driver: 'radv 25.2.0' };
    const r = await runGpuPilot(deps({ probe: async () => ({ kind: 'present', fingerprint: other }) }));
    expect(r).toMatchObject({ status: 'unsupported', reason: 'fingerprint_mismatch', rendered: false });
    expect((await runGpuPilot(deps({ pinned: [] }))).status).toBe('unsupported');
  });

  it('lease contention and stale lease produce typed outcomes without rendering', async () => {
    let rendered = false;
    const render = async () => { rendered = true; return { kind: 'failed' as const }; };
    const c = await runGpuPilot(deps({ acquireLease: async () => ({ ok: false, reason: 'contended' }), render }));
    const s = await runGpuPilot(deps({ acquireLease: async () => ({ ok: false, reason: 'stale' }), render }));
    expect(c).toMatchObject({ status: 'unavailable', reason: 'lease_contended' });
    expect(s).toMatchObject({ status: 'unavailable', reason: 'stale_lease' });
    expect(rendered).toBe(false);
  });

  it('GPU reset, loss, failure and empty frames never pass and always release the lease', async () => {
    const cases = [
      [{ kind: 'gpu_reset' as const }, 'failed', 'gpu_reset'],
      [{ kind: 'gpu_lost' as const }, 'unavailable', 'gpu_unavailable'],
      [{ kind: 'failed' as const }, 'failed', 'render_not_proven'],
      [{ kind: 'rendered' as const, fingerprint: fp, frameBytes: 0 }, 'failed', 'render_not_proven'],
      [{ kind: 'rendered' as const, fingerprint: { ...fp, device: 'other' }, frameBytes: 9 }, 'unsupported', 'fingerprint_mismatch'],
    ] as const;
    for (const [outcome, status, reason] of cases) {
      const d = deps({ render: async () => outcome });
      const r = await runGpuPilot(d);
      expect(r).toMatchObject({ status, reason, rendered: false, coverageGap: true });
      expect(d.released).toBe(1);
    }
    const thrown = deps({ render: async () => { throw new Error('boom'); } });
    expect((await runGpuPilot(thrown)).rendered).toBe(false);
    expect(thrown.released).toBe(1);
  });

  it('fingerprint ids are stable and change with any pinned field', () => {
    expect(fingerprintId(fp)).toBe(fingerprintId({ ...fp }));
    for (const k of Object.keys(fp) as (keyof GpuRuntimeFingerprint)[]) {
      expect(fingerprintId({ ...fp, [k]: k === 'api' ? 'opengl' : 'x' })).not.toBe(fingerprintId(fp));
    }
  });
});
