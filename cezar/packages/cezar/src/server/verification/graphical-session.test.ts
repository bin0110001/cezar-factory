import { describe, expect, it } from 'vitest';
import { runGraphicalSession, type GraphicalSessionSpec, type SessionHost, type SessionProcess } from './graphical-session.ts';
import { ResourceLockManager } from './resource-locks.ts';

function fakeHost(opts: { appCrashes?: boolean; xvfbNeverReady?: boolean; renderer?: string; killFails?: boolean; onSleep?: () => void } = {}) {
  const state = { dirs: new Set<string>(), alive: new Set<number>(), nextPid: 100, captured: 0 };
  const host: SessionHost = {
    async makeTempDir(p) { const d = `/tmp/${p}${state.nextPid++}`; state.dirs.add(d); return d; },
    async removeDir(p) { state.dirs.delete(p); },
    async spawn(command): Promise<SessionProcess> {
      const pid = state.nextPid++;
      state.alive.add(pid);
      let resolve!: (v: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r; });
      if (command !== 'Xvfb' && opts.appCrashes) { state.alive.delete(pid); resolve({ code: 1, signal: null }); }
      return {
        pid, exited,
        async killTree() {
          if (opts.killFails) throw new Error('survived');
          state.alive.delete(pid); resolve({ code: null, signal: 'SIGTERM' });
        },
      };
    },
    async displayReady() { return !opts.xvfbNeverReady; },
    async capture() { state.captured++; return 2048; },
    async fingerprint() { return opts.renderer ?? 'llvmpipe (LLVM 17, 256 bits)'; },
    async sleep() { opts.onSleep?.(); },
  };
  return { host, state };
}

const spec = (over: Partial<GraphicalSessionSpec> = {}): GraphicalSessionSpec => ({
  owner: 'job-a', displays: [99, 100], app: { command: 'gui-fixture' }, fencingToken: 1,
  isFenceCurrent: () => true, readyTimeoutMs: 200, ...over,
});

const clean = (state: ReturnType<typeof fakeHost>['state'], locks: ResourceLockManager) => {
  expect(state.dirs.size).toBe(0);
  expect(state.alive.size).toBe(0);
  expect(locks.tryAcquire('probe', [{ resource: 'display::99', mode: 'exclusive' }])).not.toBeNull();
};

describe('runGraphicalSession', () => {
  it('captures a screenshot and software renderer fingerprint, then leaves no residue', async () => {
    const { host, state } = fakeHost();
    const locks = new ResourceLockManager();
    let seen: string | undefined;
    const r = await runGraphicalSession(spec({ onEvidence: async (e) => { seen = e.screenshotPath; } }), host, locks);
    expect(r.status).toBe('passed');
    expect(r.evidence).toMatchObject({ display: ':99', screenshotBytes: 2048, software: true });
    expect(r.evidence?.rendererFingerprint).toContain('llvmpipe');
    expect(seen).toBe(r.evidence?.screenshotPath);
    expect(r.cleanedUp).toBe(true);
    clean(state, locks);
  });

  it('fails (not passes) when the app crashes, with full cleanup', async () => {
    const { host, state } = fakeHost({ appCrashes: true });
    const locks = new ResourceLockManager();
    const r = await runGraphicalSession(spec(), host, locks);
    expect(r.status).toBe('failed');
    expect(r.evidence).toBeUndefined();
    clean(state, locks);
  });

  it('fails on readiness timeout', async () => {
    const { host, state } = fakeHost({ xvfbNeverReady: true });
    const locks = new ResourceLockManager();
    const r = await runGraphicalSession(spec(), host, locks);
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.reason).toMatch(/not ready/);
    clean(state, locks);
  });

  it('cancel and disconnect never pass and clean up', async () => {
    for (const kind of ['cancel', 'disconnect'] as const) {
      const ac = new AbortController();
      let connected = true;
      const { host, state } = fakeHost({ onSleep: () => { if (kind === 'cancel') ac.abort(); else connected = false; } });
      const locks = new ResourceLockManager();
      const r = await runGraphicalSession(spec({ signal: ac.signal, isConnected: () => connected }), host, locks);
      expect(r.status).toBe(kind === 'cancel' ? 'cancelled' : 'disconnected');
      expect(r.evidence).toBeUndefined();
      expect(state.captured).toBe(0);
      clean(state, locks);
    }
  });

  it('stale fencing at start or mid-run is never a pass', async () => {
    const locks = new ResourceLockManager();
    const stale = await runGraphicalSession(spec({ isFenceCurrent: () => false }), fakeHost().host, locks);
    expect(stale.status).toBe('fenced');

    let current = true;
    const { host, state } = fakeHost({ onSleep: () => { current = false; } });
    const mid = await runGraphicalSession(spec({ isFenceCurrent: () => current }), host, locks);
    expect(mid.status).toBe('fenced');
    expect(mid.evidence).toBeUndefined();
    clean(state, locks);
  });

  it('cleanup failure voids a pass', async () => {
    const { host } = fakeHost({ killFails: true });
    const r = await runGraphicalSession(spec(), host, new ResourceLockManager());
    expect(r.status).toBe('failed');
    expect(r.cleanedUp).toBe(false);
    expect(r.cleanupErrors.length).toBeGreaterThan(0);
  });

  it('parallel sessions get distinct displays; exhausted pool is rejected deterministically', async () => {
    const locks = new ResourceLockManager();
    const held = [locks.tryAcquire('x', [{ resource: 'display::99', mode: 'exclusive' }])];
    const { host } = fakeHost();
    const second = await runGraphicalSession(spec(), host, locks);
    expect(second.evidence?.display).toBe(':100');
    locks.tryAcquire('y', [{ resource: 'display::100', mode: 'exclusive' }]);
    const third = await runGraphicalSession(spec(), host, locks);
    expect(third.status).toBe('contended');
    expect(held[0]).not.toBeNull();
  });

  it('flags a non-software renderer instead of claiming software rendering', async () => {
    const { host } = fakeHost({ renderer: 'NVIDIA GeForce RTX' });
    const r = await runGraphicalSession(spec(), host, new ResourceLockManager());
    expect(r.evidence?.software).toBe(false);
  });
});
