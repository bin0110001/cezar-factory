import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  matchWorkerProfile,
  resolveWorkerProfiles,
  workerInventorySchema,
  workerProfileRequestSchema,
  workerProfileTemplateSchema,
} from '@open-mercato/cezar-contract';
import { ResourceLockManager } from './resource-locks.ts';
import { scheduleJob } from './scheduler.ts';
import { parseWorkerCapabilities } from './worker-capabilities.ts';
import { discoverLocalGraphicalWorkerInventory, probeGraphicalCapabilities, refreshGraphicalWorkerInventory } from './worker-graphical-probes.ts';

const fixture = new URL('../../../../contract/fixtures/worker-profiles/worker-windows.json', import.meta.url);
const backendProfile = workerProfileTemplateSchema.parse({
  schemaVersion: 1,
  id: 'vulkan-renderer',
  requirements: { capabilities: { 'graphics.api.vulkan': true } },
  allowedCapabilities: ['graphics.api.vulkan'],
  allowedNetworkZones: ['isolated'],
  maxConcurrency: 1,
});
const policy = resolveWorkerProfiles([backendProfile]);
const request = workerProfileRequestSchema.parse({ schemaVersion: 1, requiredProfiles: ['vulkan-renderer'], requiredCapabilities: { 'graphics.api.vulkan': true } });

describe('graphical worker capability probes', () => {
  it('records validated, unknown, and failed probe outcomes with bounded reasons', async () => {
    const capabilities = await probeGraphicalCapabilities({ probes: {
      'graphics.api.opengl': async () => true,
      'graphics.api.vulkan': async () => undefined,
      'graphics.renderer': async () => { throw Object.assign(new Error('private output'), { code: 'ETIMEDOUT' }); },
    } });
    expect(capabilities).toEqual({
      'graphics.api.opengl': { status: 'validated', value: true },
      'graphics.api.vulkan': { status: 'unknown', reasonCode: 'unsupported_or_unavailable' },
      'graphics.renderer': { status: 'failed', reasonCode: 'probe_timeout' },
    });
    expect(JSON.stringify(capabilities)).not.toContain('private output');
  });

  it('creates an enrollment inventory from the detected host platform and architecture', async () => {
    const inventory = await discoverLocalGraphicalWorkerInventory({
      platform: 'win32', architecture: 'x64', now: new Date('2030-01-01T00:00:00.000Z'),
      probes: { 'graphics.api.vulkan': async () => undefined },
    });
    expect(inventory).toMatchObject({ os: 'windows', architecture: 'x64', observedAt: '2030-01-01T00:00:00.000Z' });
    expect(inventory.capabilities['graphics.api.vulkan']).toMatchObject({ status: 'unknown' });
  });

  it('treats a missing probe utility as unknown, not as a passing capability', async () => {
    const capabilities = await probeGraphicalCapabilities({ probes: { 'graphics.api.vulkan': async (execute) => {
      await execute('missing-probe-tool', [], 1_000);
      return true;
    } }, execute: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); } });
    expect(capabilities['graphics.api.vulkan']).toEqual({ status: 'unknown', reasonCode: 'probe_unavailable' });
  });

  it('publishes measured resources and runtime versions and drops unsupported old claims', async () => {
    const base = workerInventorySchema.parse({
      ...JSON.parse(await readFile(fixture, 'utf8')),
      resources: { gpuCount: 2, vramMiB: 16384, displaySlots: 4 },
      maxConcurrency: 8,
      runtimes: { godot: '4.3' },
    });
    const refreshed = await refreshGraphicalWorkerInventory(base, {
      now: new Date('2030-01-01T00:00:01.000Z'),
      probes: {
        'graphics.gpu.count': async () => 1,
        'graphics.gpu.vram-mib': async () => undefined,
        'graphics.max-sessions': async () => 2,
        'runtime.godot': async () => '4.4.1.stable',
      },
    });
    expect(refreshed.resources.gpuCount).toBe(1);
    expect(refreshed.resources).not.toHaveProperty('vramMiB');
    expect(refreshed.maxConcurrency).toBe(2);
    expect(refreshed.runtimes.godot).toBe('4.4.1.stable');

    const unsupported = await refreshGraphicalWorkerInventory(refreshed, {
      probes: {
        'graphics.gpu.count': async () => undefined,
        'graphics.max-sessions': async () => undefined,
        'runtime.godot': async () => undefined,
      },
    });
    expect(unsupported.resources).not.toHaveProperty('gpuCount');
    expect(unsupported.maxConcurrency).toBe(1);
    expect(unsupported.runtimes).not.toHaveProperty('godot');
  });

  it('does not schedule Windows for an unsupported backend and ages refreshed inventories', async () => {
    const base = workerInventorySchema.parse(JSON.parse(await readFile(fixture, 'utf8')));
    const windowsProbes = await probeGraphicalCapabilities({ platform: 'win32', execute: async () => 'adapter present' });
    const refreshed = await refreshGraphicalWorkerInventory(base, {
      platform: 'win32', now: new Date('2030-01-01T00:00:00.000Z'), execute: async () => 'adapter present',
    });
    expect(windowsProbes['graphics.api.vulkan']).toEqual({ status: 'unknown', reasonCode: 'unsupported_or_unavailable' });
    expect(matchWorkerProfile(refreshed, request, policy, { now: Date.parse(refreshed.observedAt) }).schedulable).toBe(false);
    const scheduling = await scheduleJob({ id: 'unsupported-render', requirements: {}, profileRequest: request }, [{
      id: 'windows-worker', capabilities: parseWorkerCapabilities({ os: 'win32' }), inventory: refreshed, profilePolicy: policy,
    }], new ResourceLockManager());
    expect(scheduling).toMatchObject({ status: 'unschedulable', reason: 'incompatible' });
    expect(matchWorkerProfile(refreshed, request, policy, { now: Date.parse(refreshed.observedAt) + refreshed.freshForMs + 1 })).toMatchObject({ reason: 'stale' });
  });

  it('refreshes an expired worker inventory before scheduling and keeps stale workers unschedulable on probe failure', async () => {
    const base = workerInventorySchema.parse({ ...JSON.parse(await readFile(fixture, 'utf8')), observedAt: '2000-01-01T00:00:00.000Z' });
    const worker = {
      id: 'win-renderer', capabilities: { version: 1 as const, os: 'windows', dotnet: false, gpu: false, displays: [] },
      inventory: base, profilePolicy: policy,
      refreshInventory: () => refreshGraphicalWorkerInventory(base, { probes: { 'graphics.api.vulkan': async () => true } }),
    };
    const result = await scheduleJob({ id: 'render', requirements: {}, profileRequest: request }, [worker], new ResourceLockManager());
    expect(result.status).toBe('scheduled');

    const staleWorker = { ...worker, inventory: base, refreshInventory: async () => { throw new Error('probe offline'); } };
    const staleResult = await scheduleJob({ id: 'render-stale', requirements: {}, profileRequest: request }, [staleWorker], new ResourceLockManager());
    expect(staleResult).toMatchObject({ status: 'unschedulable', reason: 'stale' });
  });
});
