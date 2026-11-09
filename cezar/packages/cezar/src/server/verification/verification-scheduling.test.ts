import { describe, expect, it } from 'vitest';
import { ResourceLockManager } from './resource-locks.ts';
import { scheduleJob } from './scheduler.ts';
import { detectWorkerCapabilities, matchRequirements, parseWorkerCapabilities } from './worker-capabilities.ts';

const guiWorker = {
  id: 'w1',
  capabilities: parseWorkerCapabilities({ os: 'linux', godot: { headless: true, gui: true }, displays: [':0'] }),
};

describe('matchRequirements', () => {
  it('matches and reports missing capabilities', () => {
    expect(matchRequirements(guiWorker.capabilities, { godotGui: true, display: ':0' })).toEqual({ schedulable: true });
    expect(matchRequirements(guiWorker.capabilities, { dotnet: true, gpu: true, display: ':1' })).toEqual({
      schedulable: false,
      missing: ['dotnet', 'gpu', 'display::1'],
    });
  });
  it('does not advertise undetected capabilities', () => {
    const c = detectWorkerCapabilities({}, 'linux');
    expect(c).toMatchObject({ os: 'linux', dotnet: false, gpu: false, displays: [] });
    expect(c.godot).toBeUndefined();
  });
});

describe('ResourceLockManager', () => {
  const x = (resource: string) => [{ resource, mode: 'exclusive' as const }];
  const s = (resource: string) => [{ resource, mode: 'shared' as const }];

  it('exclusive blocks until shared holders release or expire', () => {
    let t = 0;
    const m = new ResourceLockManager({ now: () => t });
    const a = m.tryAcquire('a', s('r'), 100)!;
    expect(m.tryAcquire('b', s('r'), 100)).not.toBeNull();
    expect(m.tryAcquire('c', x('r'), 100)).toBeNull();
    m.release(a.id);
    expect(m.tryAcquire('c', x('r'), 100)).toBeNull();
    t = 100;
    expect(m.tryAcquire('c', x('r'), 100)).not.toBeNull();
  });

  it('expired lease releases for a waiter; renew extends', async () => {
    let t = 0;
    const m = new ResourceLockManager({ now: () => t });
    const a = m.tryAcquire('a', x('r'), 100)!;
    const waiter = m.acquire('b', x('r'), 100);
    t = 50;
    expect(m.renew(a.id, 100)).toBe(true);
    t = 120;
    m.sweep();
    expect(m.waiting).toBe(1);
    t = 150;
    m.sweep();
    expect((await waiter).owner).toBe('b');
    expect(m.renew(a.id)).toBe(false);
  });
});

describe('scheduleJob', () => {
  it('runs two GUI jobs on one display serially', async () => {
    const locks = new ResourceLockManager();
    const job = (id: string) => ({ id, requirements: { godotGui: true, display: ':0' } });
    const r1 = await scheduleJob(job('j1'), [guiWorker], locks);
    expect(r1.status).toBe('scheduled');
    let second = false;
    const p2 = scheduleJob(job('j2'), [guiWorker], locks).then((r) => {
      second = true;
      return r;
    });
    await Promise.resolve();
    expect(second).toBe(false);
    if (r1.status === 'scheduled') locks.release(r1.lease.id);
    expect((await p2).status).toBe('scheduled');
  });

  it('reports unschedulable when no worker has the capability', async () => {
    const r = await scheduleJob({ id: 'j', requirements: { dotnet: true } }, [guiWorker], new ResourceLockManager());
    expect(r).toEqual({ status: 'unschedulable', missing: ['dotnet'] });
  });
});
