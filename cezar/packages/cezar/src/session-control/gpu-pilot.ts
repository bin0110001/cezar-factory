import { createHash } from 'node:crypto';

/**
 * Separately gated GPU render pilot (#341, parent #328). Pure decision logic: the probe, the render
 * proof and the resource lease are injected, so the worker adapter owns device access and this module
 * never widens it. A GPU is reported `supported` only after a real render on a fingerprint that matches
 * the pinned one; every other outcome is an explicit coverage gap and never a rendered pass.
 */

export type GpuApi = 'opengl' | 'vulkan';

/** Runtime identity pinned for reproducible verification and baseline provenance (#110). */
export interface GpuRuntimeFingerprint {
  device: string;
  driver: string;
  api: GpuApi;
  apiVersion: string;
  backend: string;
  container: string;
  runtime: string;
}

export type GpuPilotStatus = 'supported' | 'unsupported' | 'unavailable' | 'failed' | 'disabled';
/** Reason codes reuse the graphical-session failure vocabulary. */
export type GpuPilotReason =
  | 'pilot_disabled' | 'gpu_unavailable' | 'gpu_reset' | 'unsupported_renderer'
  | 'stale_capability' | 'stale_lease' | 'lease_contended' | 'render_not_proven' | 'fingerprint_mismatch';

export interface GpuPilotResult {
  status: GpuPilotStatus;
  reason?: GpuPilotReason;
  /** True only when a real render was captured on the pinned fingerprint. */
  rendered: boolean;
  /** True for every outcome that leaves the hardware unverified. */
  coverageGap: boolean;
  fingerprintId?: string;
}

export type GpuProbeOutcome =
  | { kind: 'present'; fingerprint: GpuRuntimeFingerprint }
  | { kind: 'absent' }
  | { kind: 'error' };

export type GpuRenderOutcome =
  | { kind: 'rendered'; fingerprint: GpuRuntimeFingerprint; frameBytes: number }
  | { kind: 'gpu_reset' }
  | { kind: 'gpu_lost' }
  | { kind: 'failed' };

export type GpuLeaseAttempt = { ok: true; release: () => void } | { ok: false; reason: 'contended' | 'stale' };

export interface GpuPilotDeps {
  env: Record<string, string | undefined>;
  /** The pinned fingerprints this worker is allowed to certify; empty means nothing is certified. */
  pinned: readonly GpuRuntimeFingerprint[];
  probe: () => Promise<GpuProbeOutcome>;
  acquireLease: () => Promise<GpuLeaseAttempt>;
  render: (fingerprint: GpuRuntimeFingerprint) => Promise<GpuRenderOutcome>;
}

/** The pilot needs its own flag on top of the trusted graphical-session switch; neither is inferred. */
export function gpuPilotEnabled(env: Record<string, string | undefined>): boolean {
  return env.CEZ_GRAPHICAL_SESSIONS === '1' && env.CEZ_GRAPHICAL_GPU_PILOT === '1';
}

/** Stable id over the canonical field order, so compatible selection and baselines can compare it. */
export function fingerprintId(fp: GpuRuntimeFingerprint): string {
  const canonical = JSON.stringify([fp.device, fp.driver, fp.api, fp.apiVersion, fp.backend, fp.container, fp.runtime]);
  return `gpu-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

const gap = (status: GpuPilotStatus, reason: GpuPilotReason, fingerprintIdValue?: string): GpuPilotResult => ({
  status, reason, rendered: false, coverageGap: true, ...(fingerprintIdValue ? { fingerprintId: fingerprintIdValue } : {}),
});

/** Software rendering (llvmpipe/swrast) is never GPU acceleration, whatever the display startup says. */
function isSoftwareBackend(fp: GpuRuntimeFingerprint): boolean {
  return /llvmpipe|swrast|softpipe|lavapipe|software/i.test(`${fp.device} ${fp.backend} ${fp.driver}`);
}

export async function runGpuPilot(deps: GpuPilotDeps): Promise<GpuPilotResult> {
  if (!gpuPilotEnabled(deps.env)) return gap('disabled', 'pilot_disabled');

  let probe: GpuProbeOutcome;
  try { probe = await deps.probe(); } catch { probe = { kind: 'error' }; }
  if (probe.kind === 'error') return gap('failed', 'stale_capability');
  if (probe.kind === 'absent') return gap('unavailable', 'gpu_unavailable');

  const id = fingerprintId(probe.fingerprint);
  if (isSoftwareBackend(probe.fingerprint)) return gap('unsupported', 'unsupported_renderer', id);
  if (!deps.pinned.some((p) => fingerprintId(p) === id)) return gap('unsupported', 'fingerprint_mismatch', id);

  let lease: GpuLeaseAttempt;
  try { lease = await deps.acquireLease(); } catch { return gap('failed', 'stale_lease', id); }
  if (!lease.ok) return gap('unavailable', lease.reason === 'stale' ? 'stale_lease' : 'lease_contended', id);

  try {
    let render: GpuRenderOutcome;
    try { render = await deps.render(probe.fingerprint); } catch { render = { kind: 'failed' }; }
    switch (render.kind) {
      case 'gpu_reset': return gap('failed', 'gpu_reset', id);
      case 'gpu_lost': return gap('unavailable', 'gpu_unavailable', id);
      case 'failed': return gap('failed', 'render_not_proven', id);
      case 'rendered':
        // The render must come from the pinned runtime and produce a frame; otherwise nothing is proven.
        if (fingerprintId(render.fingerprint) !== id) return gap('unsupported', 'fingerprint_mismatch', id);
        if (render.frameBytes <= 0) return gap('failed', 'render_not_proven', id);
        return { status: 'supported', rendered: true, coverageGap: false, fingerprintId: id };
    }
  } finally {
    lease.release();
  }
}
