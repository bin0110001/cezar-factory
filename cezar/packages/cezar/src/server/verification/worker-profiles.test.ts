import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_WORKER_PROFILES,
  matchWorkerProfile,
  resolveWorkerProfiles,
  workerInventorySchema,
  workerProfileOverrideSchema,
  workerProfileRequestSchema,
  workerProfileTemplateSchema,
} from '@open-mercato/cezar-contract';
import { ResourceLockManager } from './resource-locks.ts';
import { scheduleJob } from './scheduler.ts';
import { runWorkerProfilesCommand } from './worker-profiles-cli.ts';
import { parseWorkerCapabilities } from './worker-capabilities.ts';

const fixtures = new URL('../../../../contract/fixtures/worker-profiles/', import.meta.url);
const inventory = async (name: string) => workerInventorySchema.parse(JSON.parse(await readFile(new URL(name, fixtures), 'utf8')));

const browserProfile = workerProfileTemplateSchema.parse({
  schemaVersion: 1,
  id: 'browser-headless',
  tags: ['browser'],
  requirements: {
    capabilities: { 'browser.headless': true },
    minResources: { cpuCores: 2, memoryMiB: 2048 },
    minimumIsolation: 'container',
    networkZones: ['isolated'],
    runtimes: { chromium: '140.0' },
  },
  allowedCapabilities: ['browser.headless'],
  allowedNetworkZones: ['isolated', 'restricted'],
  maxConcurrency: 3,
});
const browserPolicy = resolveWorkerProfiles([browserProfile]);
const browserRequest = workerProfileRequestSchema.parse({
  schemaVersion: 1,
  requiredProfiles: ['browser-headless'],
  requiredCapabilities: { 'browser.headless': true },
  minResources: { cpuCores: 1, memoryMiB: 1024 },
  networkZone: 'isolated',
  locality: 'prefer-local',
  affinityTags: ['chromium'],
});

describe('versioned worker profiles and inventory', () => {
  it('accepts equivalent Windows and Linux browser workers and rejects unknown versions', async () => {
    const linux = await inventory('worker-linux.json');
    const windows = await inventory('worker-windows.json');
    expect(matchWorkerProfile(linux, browserRequest, browserPolicy, { now: Date.parse(linux.observedAt) }).schedulable).toBe(true);
    expect(matchWorkerProfile(windows, browserRequest, browserPolicy, { now: Date.parse(windows.observedAt) }).schedulable).toBe(true);
    expect(workerInventorySchema.safeParse({ ...linux, schemaVersion: 2 }).success).toBe(false);
    expect(workerProfileRequestSchema.safeParse({ ...browserRequest, godotHeadless: true }).success).toBe(false);
  });

  it('treats unknown and failed probes as unavailable, never as a pass', async () => {
    const base = await inventory('worker-linux.json');
    const unknown = workerInventorySchema.parse({ ...base, capabilities: { 'browser.headless': { status: 'unknown' } } });
    const failed = workerInventorySchema.parse({ ...base, capabilities: { 'browser.headless': { status: 'failed', reasonCode: 'probe_timeout' } } });
    expect(matchWorkerProfile(unknown, browserRequest, browserPolicy, { now: Date.parse(base.observedAt) })).toMatchObject({ schedulable: false, reason: 'incompatible', missing: ['capability:browser.headless'] });
    expect(matchWorkerProfile(failed, browserRequest, browserPolicy, { now: Date.parse(base.observedAt) })).toMatchObject({ schedulable: false, reason: 'incompatible', missing: ['capability:browser.headless'] });
    expect(workerInventorySchema.safeParse({ ...base, capabilities: { 'browser.headless': { status: 'validated' } } }).success).toBe(false);
  });

  it('reports stale, incompatible, saturated and policy-denied separately', async () => {
    const base = await inventory('worker-linux.json');
    expect(matchWorkerProfile(base, browserRequest, browserPolicy, { now: Date.parse(base.observedAt) + base.freshForMs + 1 })).toMatchObject({ reason: 'stale' });
    const tooLarge = workerProfileRequestSchema.parse({ ...browserRequest, minResources: { memoryMiB: 32_768 } });
    expect(matchWorkerProfile(base, tooLarge, browserPolicy, { now: Date.parse(base.observedAt) })).toMatchObject({ reason: 'incompatible', missing: ['resource:memoryMiB'] });
    expect(matchWorkerProfile(base, browserRequest, browserPolicy, { now: Date.parse(base.observedAt), activeJobs: 3 })).toMatchObject({ reason: 'saturated' });
    const forbidden = workerProfileRequestSchema.parse({ ...browserRequest, requiredCapabilities: { 'host.shell': true } });
    expect(matchWorkerProfile(base, forbidden, browserPolicy, { now: Date.parse(base.observedAt) })).toMatchObject({ reason: 'policy-denied', missing: ['capability:host.shell:denied'] });
    const weakened = workerProfileRequestSchema.parse({ ...browserRequest, requiredCapabilities: { 'browser.headless': false } });
    expect(matchWorkerProfile(base, weakened, browserPolicy, { now: Date.parse(base.observedAt) })).toMatchObject({ reason: 'policy-denied', missing: ['capability:browser.headless:conflicts-with-profile'] });
    const localOnly = workerProfileRequestSchema.parse({ ...browserRequest, locality: 'require-local' });
    expect(matchWorkerProfile(base, localOnly, browserPolicy, { now: Date.parse(base.observedAt), isLocal: false })).toMatchObject({ reason: 'incompatible', missing: ['locality:local-required'] });
    expect(matchWorkerProfile(base, localOnly, browserPolicy, { now: Date.parse(base.observedAt), isLocal: true }).schedulable).toBe(true);
  });

  it('combines trusted profiles and permits overrides only when they tighten policy', () => {
    const gui = BUILTIN_WORKER_PROFILES.find((profile) => profile.id === 'gui')!;
    const general = BUILTIN_WORKER_PROFILES.find((profile) => profile.id === 'general-compute')!;
    const policy = resolveWorkerProfiles([gui, general]);
    expect(policy.profileIds).toEqual(['general-compute', 'gui']);
    expect(policy.allowedNetworkZones).toEqual(['isolated', 'restricted']);
    expect(policy.maxConcurrency).toBe(1);
    const tightened = resolveWorkerProfiles([browserProfile], workerProfileOverrideSchema.parse({
      allowedCapabilities: ['browser.headless'], allowedNetworkZones: ['isolated'], maxConcurrency: 1,
      requiredCapabilities: { 'browser.headless': true }, minResources: { memoryMiB: 4096 }, minimumIsolation: 'vm',
    }));
    expect(tightened.maxConcurrency).toBe(1);
    expect(tightened.allowedNetworkZones).toEqual(['isolated']);
    expect(tightened.minResources.memoryMiB).toBe(4096);
    expect(() => resolveWorkerProfiles([browserProfile], { allowedCapabilities: ['host.shell'] })).toThrow('cannot grant a capability');
    expect(() => resolveWorkerProfiles([browserProfile], { allowedNetworkZones: ['internet'] })).toThrow('cannot widen');
    expect(() => resolveWorkerProfiles([browserProfile], { maxConcurrency: 4 })).toThrow('cannot increase');
    expect(() => resolveWorkerProfiles([browserProfile], { requiredCapabilities: { 'browser.headless': false } })).toThrow('cannot replace requirement');
    const conflict = workerProfileTemplateSchema.parse({ ...browserProfile, id: 'conflicting-browser', requirements: { ...browserProfile.requirements, capabilities: { 'browser.headless': false } } });
    expect(() => resolveWorkerProfiles([browserProfile, conflict])).toThrow('conflicting worker profile requirement');
  });

  it('keeps same-display session leases serialized in existing admission and preserves legacy workers', async () => {
    const base = await inventory('worker-linux.json');
    const locks = new ResourceLockManager();
    const worker = { id: 'browser-worker', capabilities: parseWorkerCapabilities({ os: 'linux' }), inventory: base, profilePolicy: browserPolicy };
    const job = (id: string) => ({ id, requirements: {}, profileRequest: workerProfileRequestSchema.parse({ ...browserRequest, leases: [{ resource: 'display:private-1', mode: 'exclusive' }] }) });
    const first = await scheduleJob(job('one'), [worker], locks);
    expect(first.status).toBe('scheduled');
    let secondDone = false;
    const secondPromise = scheduleJob(job('two'), [worker], locks).then((result) => { secondDone = true; return result; });
    await Promise.resolve();
    expect(secondDone).toBe(false);
    if (first.status === 'scheduled') locks.release(first.lease.id);
    expect((await secondPromise).status).toBe('scheduled');

    const singleSlotWorker = { ...worker, inventory: workerInventorySchema.parse({ ...base, maxConcurrency: 1 }) };
    const slotLocks = new ResourceLockManager();
    const noDisplay = (id: string) => ({ id, requirements: {}, profileRequest: workerProfileRequestSchema.parse(browserRequest) });
    const slotOne = await scheduleJob(noDisplay('slot-one'), [singleSlotWorker], slotLocks);
    let slotTwoDone = false;
    const slotTwoPromise = scheduleJob(noDisplay('slot-two'), [singleSlotWorker], slotLocks).then((result) => { slotTwoDone = true; return result; });
    await Promise.resolve();
    expect(slotTwoDone).toBe(false);
    if (slotOne.status === 'scheduled') slotLocks.release(slotOne.lease.id);
    expect((await slotTwoPromise).status).toBe('scheduled');

    const legacy = await scheduleJob({ id: 'legacy', requirements: { os: 'linux' } }, [{ id: 'local', capabilities: parseWorkerCapabilities({ os: 'linux' }) }], new ResourceLockManager());
    expect(legacy.status).toBe('scheduled');
  });

  it('provides read-only redacted local inventory inspection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cezar-worker-profile-'));
    try {
      await writeFile(join(directory, 'inventory.json'), await readFile(new URL('worker-linux.json', fixtures), 'utf8'));
      const output: string[] = [];
      const code = await runWorkerProfilesCommand(['inspect', 'inventory.json'], {
        cwd: directory, now: Date.parse('2030-01-01T00:00:01.000Z'), stdout: (text) => output.push(text), stderr: (text) => output.push(text),
      });
      expect(code).toBe(0);
      const rendered = output.join('\n');
      expect(rendered).toContain('"stale": false');
      expect(rendered).toContain('"validated": 1');
      expect(rendered).not.toContain('140.0');
      expect(rendered).not.toContain('browser.headless');
      expect(await runWorkerProfilesCommand(['list'], { stdout: (text) => output.push(text) })).toBe(0);
      await writeFile(join(directory, 'invalid.json'), JSON.stringify({ schemaVersion: 1, apiKey: 'do-not-print-this-secret' }));
      const errors: string[] = [];
      expect(await runWorkerProfilesCommand(['inspect', 'invalid.json'], { cwd: directory, stderr: (text) => errors.push(text) })).toBe(1);
      expect(errors.join('\n')).not.toContain('do-not-print-this-secret');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
