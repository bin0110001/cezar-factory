import { describe, expect, it } from 'vitest';
import type { JobRequirements, WorkerCapabilities } from './worker-capabilities.ts';
import { matchRequirements, parseWorkerCapabilities } from './worker-capabilities.ts';
import { ResourceLockManager } from './resource-locks.ts';
import { scheduleJob, type VerificationJob, type VerificationWorker } from './scheduler.ts';
import { runGraphicalSession, type SessionHost, type SessionProcess } from './graphical-session.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A deterministic worker double: its declared capabilities and resource leases go through the
 * real scheduler, while start/release gates let tests coordinate jobs without timing sleeps. */
class MockRemoteAgent {
  readonly locks = new ResourceLockManager();
  readonly worker: VerificationWorker;
  active = 0;
  peakActive = 0;

  constructor(id: string, capabilities: WorkerCapabilities) {
    this.worker = { id, capabilities };
  }

  async dispatch<T>(job: VerificationJob, work: (signal: AbortSignal) => Promise<T>, signal = new AbortController().signal): Promise<T | { unschedulable: string[] }> {
    const scheduled = await scheduleJob(job, [this.worker], this.locks);
    if (scheduled.status === 'unschedulable') return { unschedulable: scheduled.missing };
    this.active++;
    this.peakActive = Math.max(this.peakActive, this.active);
    try { return await work(signal); }
    finally {
      this.active--;
      this.locks.release(scheduled.lease.id);
    }
  }
}

const displayJob = (id: string, display: string): VerificationJob => ({
  id,
  requirements: { os: 'linux', display },
});

function mockSessionHost(options: { screenshotBytes?: number; onSleep?: () => void } = {}) {
  const dirs = new Set<string>(['/mock-agent/foreign-run']);
  const alive = new Set<number>();
  let next = 1;
  const host: SessionHost = {
    async makeTempDir() { const path = `/mock-agent/run-${next++}`; dirs.add(path); return path; },
    async removeDir(path) { dirs.delete(path); },
    async spawn(): Promise<SessionProcess> {
      const pid = next++;
      alive.add(pid);
      let finish!: (value: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { finish = resolve; });
      return { pid, exited, async killTree() { alive.delete(pid); finish({ code: null, signal: 'SIGTERM' }); } };
    },
    async displayReady() { return true; },
    async capture() { return options.screenshotBytes ?? 128; },
    async fingerprint() { return 'llvmpipe'; },
    async sleep() { options.onSleep?.(); },
  };
  return { host, dirs, alive };
}

describe('cross-platform mock remote-agent integration', () => {
  it('admits independent display jobs concurrently and serializes jobs sharing a display', async () => {
    const agent = new MockRemoteAgent('linux-gui', parseWorkerCapabilities({ os: 'linux', godot: { gui: true }, displays: [':99', ':100'] }));
    const startedA = deferred();
    const startedB = deferred();
    const finishA = deferred();
    const finishB = deferred();
    const a = agent.dispatch(displayJob('a', ':99'), async () => { startedA.resolve(); await finishA.promise; });
    const b = agent.dispatch(displayJob('b', ':100'), async () => { startedB.resolve(); await finishB.promise; });
    await Promise.all([startedA.promise, startedB.promise]);
    expect(agent.peakActive).toBe(2);
    finishA.resolve(); finishB.resolve();
    await Promise.all([a, b]);

    const firstStarted = deferred();
    const secondStarted = deferred();
    const finishFirst = deferred();
    const first = agent.dispatch(displayJob('same-a', ':99'), async () => { firstStarted.resolve(); await finishFirst.promise; });
    await firstStarted.promise;
    const second = agent.dispatch(displayJob('same-b', ':99'), async () => { secondStarted.resolve(); });
    await Promise.resolve();
    expect(agent.active).toBe(1);
    finishFirst.resolve();
    await Promise.all([first, second]);
    await secondStarted.promise;
    expect(agent.active).toBe(0);
  });

  it('fails closed when a worker does not advertise the requested platform capability', async () => {
    const agent = new MockRemoteAgent('linux-only', parseWorkerCapabilities({ os: 'linux', displays: [':99'] }));
    const requirements: JobRequirements = { os: 'windows', godotGui: true, display: ':99' };
    expect(matchRequirements(agent.worker.capabilities, requirements)).toEqual({
      schedulable: false,
      missing: ['os:windows', 'godot:gui'],
    });
    const result = await agent.dispatch({ id: 'unsupported', requirements }, async () => 'must not run');
    expect(result).toEqual({ unschedulable: ['os:windows', 'godot:gui'] });
  });

  it('releases a worker lease after cancellation so the next job can start', async () => {
    const agent = new MockRemoteAgent('linux-worker', parseWorkerCapabilities({ os: 'linux' }));
    const started = deferred();
    const controller = new AbortController();
    const first = agent.dispatch({ id: 'cancel-me', requirements: { os: 'linux' } }, async (signal) => {
      started.resolve();
      await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    }, controller.signal);
    await started.promise;
    controller.abort();
    await expect(first).rejects.toThrow('cancelled');

    let ran = false;
    await agent.dispatch({ id: 'after-cancel', requirements: { os: 'linux' } }, async () => { ran = true; });
    expect(ran).toBe(true);
    expect(agent.active).toBe(0);
    expect(agent.locks.waiting).toBe(0);
  });

  it('treats an artifact quota breach as failure and cleans only that run environment', async () => {
    const { host, dirs, alive } = mockSessionHost({ screenshotBytes: 129 });
    const locks = new ResourceLockManager();
    const result = await runGraphicalSession({
      owner: 'quota-run', displays: [99], app: { command: 'mock-app' }, fencingToken: 1,
      isFenceCurrent: () => true, maxScreenshotBytes: 128,
    }, host, locks);

    expect(result).toMatchObject({ status: 'failed', cleanedUp: true });
    expect(result.reason).toContain('exceeds bound');
    expect(dirs).toEqual(new Set(['/mock-agent/foreign-run']));
    expect(alive.size).toBe(0);
    expect(locks.tryAcquire('probe', [{ resource: 'display::99', mode: 'exclusive' }])).not.toBeNull();
  });

  it('cleans the canceled run and releases its display while preserving another run directory', async () => {
    const controller = new AbortController();
    const { host, dirs, alive } = mockSessionHost({ onSleep: () => controller.abort() });
    const locks = new ResourceLockManager();
    const result = await runGraphicalSession({
      owner: 'cancel-run', displays: [99], app: { command: 'mock-app' }, fencingToken: 1,
      isFenceCurrent: () => true, signal: controller.signal,
    }, host, locks);

    expect(result).toMatchObject({ status: 'cancelled', cleanedUp: true });
    expect(dirs).toEqual(new Set(['/mock-agent/foreign-run']));
    expect(alive.size).toBe(0);
    expect(locks.tryAcquire('probe', [{ resource: 'display::99', mode: 'exclusive' }])).not.toBeNull();
  });
});
