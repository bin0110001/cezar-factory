import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  workerInventorySchema,
  type WorkerInventory,
  type WorkerCapabilityObservation,
} from '@open-mercato/cezar-contract';

const execFileAsync = promisify(execFile);
type ProbeValue = boolean | number | string;
export type GraphicalProbeExecutor = (command: string, args: string[], timeoutMs: number) => Promise<string>;
export type GraphicalProbe = (execute: GraphicalProbeExecutor) => Promise<ProbeValue | undefined>;

const runCommand: GraphicalProbeExecutor = async (command, args, timeoutMs) => {
  try {
    const result = await execFileAsync(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 });
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch (error) {
    // Xvfb prints its supported options and exits 1 for -help. Other nonzero
    // diagnostic commands represent failed probes even when they print output.
    if (command === 'Xvfb' && typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number') {
      const output = error as { stdout?: string; stderr?: string };
      return `${output.stdout ?? ''}\n${output.stderr ?? ''}`;
    }
    throw error;
  }
};

function commandProbe(command: string, args: string[], parse: (output: string) => ProbeValue | undefined): GraphicalProbe {
  return async (execute) => parse(await execute(command, args, 2_000));
}

function linuxProbes(): Record<string, GraphicalProbe> {
  const vulkanSummary = (output: string) => output.match(/GPU\d+:\s*([^\r\n]+)/i)?.[1]?.trim();
  return {
    'graphics.api.vulkan': commandProbe('vulkaninfo', ['--summary'], (output) => /deviceName\s*=\s*\S/i.test(output)),
    'graphics.gpu.count': commandProbe('vulkaninfo', ['--summary'], (output) => {
      const devices = output.match(/^GPU\d+:/gim);
      return devices?.length ?? (vulkanSummary(output) ? 1 : undefined);
    }),
    'graphics.gpu.vram-mib': commandProbe('vulkaninfo', ['--summary'], (output) => {
      const heaps = [...output.matchAll(/heapSize\s*=\s*(0x[0-9a-f]+)/gi)].map((match) => Number.parseInt(match[1]!, 16));
      return heaps.length ? Math.floor(Math.max(...heaps) / (1024 * 1024)) : undefined;
    }),
    'graphics.api.opengl': commandProbe('glxinfo', ['-B'], (output) => /OpenGL (?:core profile )?version string:/i.test(output)),
    'graphics.renderer': commandProbe('glxinfo', ['-B'], (output) => output.match(/OpenGL renderer string:\s*(.+)/i)?.[1]?.trim()),
    'graphics.driver': commandProbe('lspci', ['-k'], (output) => output.match(/Kernel driver in use:\s*(.+)/i)?.[1]?.trim()),
    'graphics.virtual-display': commandProbe('Xvfb', ['-help'], (output) => /usage: Xvfb|Xvfb command line options/i.test(output)),
    'runtime.godot': commandProbe('godot', ['--version'], (output) => output.match(/\d+\.\d+(?:\.\d+)?(?:\.\w+)?/)?.[0]),
    // Capturing a frame needs an authorized interactive display session; leave unknown here.
    'graphics.screen-capture': unsupportedProbe(),
    'graphics.max-sessions': unsupportedProbe(),
    'graphics.display.slots': unsupportedProbe(),
  };
}

function windowsProbes(): Record<string, GraphicalProbe> {
  const powershell = 'powershell.exe';
  return {
    'graphics.driver': commandProbe(powershell, ['-NoProfile', '-NonInteractive', '-Command', "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty DriverVersion)"], (output) => output.trim() || undefined),
    'graphics.gpu.count': commandProbe(powershell, ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_VideoController).Count"], (output) => {
      const count = Number.parseInt(output.trim(), 10);
      return Number.isFinite(count) ? count : undefined;
    }),
    'runtime.godot': commandProbe('godot.exe', ['--version'], (output) => output.match(/\d+\.\d+(?:\.\d+)?(?:\.\w+)?/)?.[0]),
    // Do not infer rendering backends from the presence of a Windows display adapter.
    'graphics.api.vulkan': unsupportedProbe(),
    'graphics.api.opengl': unsupportedProbe(),
    'graphics.api.direct3d': unsupportedProbe(),
    'graphics.renderer': unsupportedProbe(),
    'graphics.virtual-display': unsupportedProbe(),
    'graphics.screen-capture': unsupportedProbe(),
    'graphics.max-sessions': unsupportedProbe(),
    'graphics.display.slots': unsupportedProbe(),
    'graphics.gpu.vram-mib': unsupportedProbe(),
  };
}

function unsupportedProbe(): GraphicalProbe {
  return async () => undefined;
}

export function graphicalProbesForPlatform(platform: string = process.platform): Record<string, GraphicalProbe> {
  if (platform === 'linux') return linuxProbes();
  if (platform === 'win32') return windowsProbes();
  return {
    'graphics.api.vulkan': unsupportedProbe(),
    'graphics.api.opengl': unsupportedProbe(),
    'graphics.renderer': unsupportedProbe(),
    'graphics.virtual-display': unsupportedProbe(),
    'graphics.screen-capture': unsupportedProbe(),
    'graphics.max-sessions': unsupportedProbe(),
    'graphics.display.slots': unsupportedProbe(),
    'graphics.gpu.count': unsupportedProbe(),
    'graphics.gpu.vram-mib': unsupportedProbe(),
  };
}

function reasonFor(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT') return 'probe_unavailable';
  if (code === 'ETIMEDOUT' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'probe_timeout';
  return 'probe_failed';
}

/** Run bounded local capability probes. A missing tool or unsupported platform is unknown, never a pass. */
export async function probeGraphicalCapabilities(options: {
  platform?: string;
  probes?: Record<string, GraphicalProbe>;
  execute?: GraphicalProbeExecutor;
} = {}): Promise<Record<string, WorkerCapabilityObservation>> {
  const probes = options.probes ?? graphicalProbesForPlatform(options.platform);
  const execute = options.execute ?? runCommand;
  const results: Array<[string, WorkerCapabilityObservation]> = await Promise.all(Object.entries(probes).map(async ([name, probe]): Promise<[string, WorkerCapabilityObservation]> => {
    try {
      const value = await probe(execute);
      return [name, value === undefined
        ? { status: 'unknown', reasonCode: 'unsupported_or_unavailable' }
        : { status: 'validated', value }];
    } catch (error) {
      const reasonCode = reasonFor(error);
      return [name, reasonCode === 'probe_unavailable'
        ? { status: 'unknown', reasonCode }
        : { status: 'failed', reasonCode }];
    }
  }));
  return Object.fromEntries(results);
}

/** Replace graphical observations and refresh the single inventory freshness timestamp. */
export async function refreshGraphicalWorkerInventory(
  inventory: WorkerInventory,
  options: { now?: Date; platform?: string; probes?: Record<string, GraphicalProbe>; execute?: GraphicalProbeExecutor } = {},
): Promise<WorkerInventory> {
  const capabilities = await probeGraphicalCapabilities(options);
  const resources = { ...inventory.resources };
  const resourceProbes: Array<[keyof typeof resources, string]> = [
    ['gpuCount', 'graphics.gpu.count'], ['vramMiB', 'graphics.gpu.vram-mib'], ['displaySlots', 'graphics.display.slots'],
  ];
  for (const [field, name] of resourceProbes) {
    const observation = capabilities[name];
    if (observation?.status === 'validated' && typeof observation.value === 'number') resources[field] = observation.value;
    else if (observation) delete resources[field];
  }
  const sessions = capabilities['graphics.max-sessions'];
  const maxConcurrency = sessions?.status === 'validated' && typeof sessions.value === 'number'
    ? Math.max(1, Math.floor(sessions.value))
    : sessions ? 1 : inventory.maxConcurrency;
  const godot = capabilities['runtime.godot'];
  const runtimes = { ...inventory.runtimes };
  if (godot?.status === 'validated' && typeof godot.value === 'string') runtimes.godot = godot.value;
  else if (godot) delete runtimes.godot;
  return workerInventorySchema.parse({
    ...inventory,
    capabilities: { ...inventory.capabilities, ...capabilities },
    resources,
    runtimes,
    maxConcurrency,
    observedAt: (options.now ?? new Date()).toISOString(),
  });
}

/** Build an initial local inventory at worker enrollment using host OS/architecture and live probes. */
export async function discoverLocalGraphicalWorkerInventory(options: {
  now?: Date;
  platform?: string;
  architecture?: string;
  executors?: string[];
  isolation?: WorkerInventory['isolation'];
  networkZones?: WorkerInventory['networkZones'];
  storage?: string[];
  accessibility?: string[];
  profileTags?: string[];
  freshForMs?: number;
  probes?: Record<string, GraphicalProbe>;
  execute?: GraphicalProbeExecutor;
} = {}): Promise<WorkerInventory> {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? new Date();
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;
  const inventory = workerInventorySchema.parse({
    schemaVersion: 1,
    os,
    architecture: options.architecture ?? process.arch,
    executors: options.executors ?? ['node'],
    runtimes: {},
    resources: {},
    isolation: options.isolation ?? 'none',
    networkZones: options.networkZones ?? [],
    storage: options.storage ?? [],
    accessibility: options.accessibility ?? [],
    capabilities: {},
    profileTags: options.profileTags ?? [],
    maxConcurrency: 1,
    observedAt: now.toISOString(),
    freshForMs: options.freshForMs ?? 300_000,
  });
  return refreshGraphicalWorkerInventory(inventory, { ...options, now, platform });
}
