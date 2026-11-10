import { z } from 'zod';

export const WORKER_PROFILE_VERSION = 1 as const;
export const workerNetworkZoneSchema = z.enum(['isolated', 'restricted', 'internet']);
export const workerIsolationSchema = z.enum(['none', 'process', 'container', 'vm']);
const capabilityNameSchema = z.string().min(3).max(128).regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9._-]*$/, 'capability names must be namespaced');
const capabilityValueSchema = z.union([z.boolean(), z.number().finite(), z.string().max(256)]);

export const workerResourceQuantitiesSchema = z.object({
  cpuCores: z.number().finite().min(0).max(4_096).optional(),
  memoryMiB: z.number().int().min(0).max(4_194_304).optional(),
  diskMiB: z.number().int().min(0).max(16_777_216).optional(),
  gpuCount: z.number().int().min(0).max(256).optional(),
  vramMiB: z.number().int().min(0).max(1_048_576).optional(),
  displaySlots: z.number().int().min(0).max(256).optional(),
  networkMbps: z.number().finite().min(0).max(1_000_000).optional(),
}).strict();
export type WorkerResourceQuantities = z.infer<typeof workerResourceQuantitiesSchema>;

export const workerCapabilityObservationSchema = z.object({
  status: z.enum(['validated', 'unknown', 'failed']),
  value: capabilityValueSchema.optional(),
  reasonCode: z.string().min(1).max(128).optional(),
}).strict().superRefine((observation, ctx) => {
  if (observation.status === 'validated' && observation.value === undefined) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'validated capabilities require an observed value' });
  }
  if (observation.status !== 'validated' && observation.value !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'unknown and failed capabilities cannot assert a value' });
  }
  if (observation.status === 'failed' && !observation.reasonCode) {
    ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'failed probes require a reason code' });
  }
});

const namespacedObservationsSchema = z.record(capabilityNameSchema, workerCapabilityObservationSchema).default({});
const capabilityValuesSchema = z.record(capabilityNameSchema, capabilityValueSchema).default({});
const runtimeVersionsSchema = z.record(z.string().min(1).max(128), z.string().min(1).max(128)).default({});

export const workerInventorySchema = z.object({
  schemaVersion: z.literal(WORKER_PROFILE_VERSION),
  os: z.string().min(1).max(128),
  architecture: z.string().min(1).max(64),
  executors: z.array(z.string().min(1).max(128)).max(128).default([]),
  runtimes: runtimeVersionsSchema,
  resources: workerResourceQuantitiesSchema,
  isolation: workerIsolationSchema,
  networkZones: z.array(workerNetworkZoneSchema).max(3).default([]),
  storage: z.array(z.string().min(1).max(128)).max(128).default([]),
  accessibility: z.array(z.string().min(1).max(128)).max(128).default([]),
  capabilities: namespacedObservationsSchema,
  profileTags: z.array(z.string().min(1).max(128)).max(128).default([]),
  maxConcurrency: z.number().int().min(1).max(4_096).default(1),
  observedAt: z.string().datetime(),
  freshForMs: z.number().int().min(1_000).max(86_400_000).default(300_000),
}).strict();
export type WorkerInventory = z.infer<typeof workerInventorySchema>;

/** Safe inventory view for operator inspection; omits capability values and arbitrary runtime metadata. */
export function summarizeWorkerInventory(inventory: WorkerInventory, now = Date.now()) {
  const capabilityCounts = { validated: 0, unknown: 0, failed: 0 };
  for (const observation of Object.values(inventory.capabilities)) capabilityCounts[observation.status]++;
  const observed = Date.parse(inventory.observedAt);
  return {
    schemaVersion: inventory.schemaVersion,
    os: inventory.os,
    architecture: inventory.architecture,
    executors: [...inventory.executors].sort(),
    runtimeNames: Object.keys(inventory.runtimes).sort(),
    resourceNames: Object.keys(inventory.resources).sort(),
    isolation: inventory.isolation,
    networkZones: [...inventory.networkZones].sort(),
    storage: [...inventory.storage].sort(),
    accessibility: [...inventory.accessibility].sort(),
    profileTags: [...inventory.profileTags].sort(),
    capabilityCounts,
    maxConcurrency: inventory.maxConcurrency,
    observedAt: inventory.observedAt,
    stale: !Number.isFinite(observed) || now > observed + inventory.freshForMs,
  };
}

export const workerProfileRequirementsSchema = z.object({
  capabilities: capabilityValuesSchema,
  minResources: workerResourceQuantitiesSchema.default({}),
  minimumIsolation: workerIsolationSchema.optional(),
  networkZones: z.array(workerNetworkZoneSchema).max(3).default([]),
  runtimes: runtimeVersionsSchema,
}).strict();

export const workerProfileTemplateSchema = z.object({
  schemaVersion: z.literal(WORKER_PROFILE_VERSION),
  id: z.string().min(1).max(128),
  tags: z.array(z.string().min(1).max(128)).max(128).default([]),
  requirements: workerProfileRequirementsSchema,
  /** Capability grants are policy metadata, never proof that a worker has a capability. */
  allowedCapabilities: z.array(capabilityNameSchema).max(256).default([]),
  allowedNetworkZones: z.array(workerNetworkZoneSchema).min(1).max(3),
  maxConcurrency: z.number().int().min(1).max(4_096).default(1),
}).strict();
export type WorkerProfileTemplate = z.infer<typeof workerProfileTemplateSchema>;

export const workerProfileOverrideSchema = z.object({
  allowedCapabilities: z.array(capabilityNameSchema).optional(),
  allowedNetworkZones: z.array(workerNetworkZoneSchema).optional(),
  maxConcurrency: z.number().int().min(1).max(4_096).optional(),
  requiredCapabilities: capabilityValuesSchema.optional(),
  minResources: workerResourceQuantitiesSchema.optional(),
  minimumIsolation: workerIsolationSchema.optional(),
}).strict();
export type WorkerProfileOverride = z.infer<typeof workerProfileOverrideSchema>;

export const workerProfileRequestSchema = z.object({
  schemaVersion: z.literal(WORKER_PROFILE_VERSION),
  requiredProfiles: z.array(z.string().min(1).max(128)).max(32).default([]),
  requiredCapabilities: capabilityValuesSchema,
  minResources: workerResourceQuantitiesSchema.default({}),
  minimumIsolation: workerIsolationSchema.optional(),
  networkZone: workerNetworkZoneSchema.optional(),
  affinityTags: z.array(z.string().min(1).max(128)).max(64).default([]),
  antiAffinityTags: z.array(z.string().min(1).max(128)).max(64).default([]),
  locality: z.enum(['none', 'prefer-local', 'require-local']).default('none'),
  maxConcurrency: z.number().int().min(1).max(4_096).optional(),
  schedulingPriority: z.number().int().min(-10).max(10).default(0),
  leases: z.array(z.object({ resource: z.string().min(1).max(256), mode: z.enum(['shared', 'exclusive']) }).strict()).max(64).default([]),
}).strict();
export type WorkerProfileRequest = z.infer<typeof workerProfileRequestSchema>;

export type WorkerProfilePolicy = {
  profileIds: string[];
  allowedCapabilities: string[];
  allowedNetworkZones: Array<z.infer<typeof workerNetworkZoneSchema>>;
  requiredNetworkZones: Array<z.infer<typeof workerNetworkZoneSchema>>;
  requiredRuntimes: Record<string, string>;
  maxConcurrency: number;
  requiredCapabilities: Record<string, z.infer<typeof capabilityValueSchema>>;
  minResources: WorkerResourceQuantities;
  minimumIsolation?: z.infer<typeof workerIsolationSchema>;
  tags: string[];
};

const isolationRank = { none: 0, process: 1, container: 2, vm: 3 } as const;
const isolationAtLeast = (actual: WorkerInventory['isolation'], required: WorkerInventory['isolation']) => isolationRank[actual] >= isolationRank[required];

function mergeResourceMinimums(items: WorkerResourceQuantities[]): WorkerResourceQuantities {
  const keys: Array<keyof WorkerResourceQuantities> = ['cpuCores', 'memoryMiB', 'diskMiB', 'gpuCount', 'vramMiB', 'displaySlots', 'networkMbps'];
  const merged: WorkerResourceQuantities = {};
  for (const key of keys) {
    const values = items.map((item) => item[key]).filter((value): value is number => value !== undefined);
    if (values.length) Object.assign(merged, { [key]: Math.max(...values) });
  }
  return merged;
}

function mergeExactConstraints<T extends Record<string, unknown>>(records: T[]): T {
  const merged: Record<string, unknown> = {};
  for (const record of records) {
    for (const [name, value] of Object.entries(record)) {
      if (name in merged && merged[name] !== value) throw new Error(`conflicting worker profile requirement: ${name}`);
      merged[name] = value;
    }
  }
  return merged as T;
}

/** Combine trusted templates; requirements tighten and policy grants combine deterministically. */
export function resolveWorkerProfiles(profiles: WorkerProfileTemplate[], override?: WorkerProfileOverride): WorkerProfilePolicy {
  if (profiles.length === 0) throw new Error('at least one trusted worker profile is required');
  const allowedCapabilities = [...new Set(profiles.flatMap((profile) => profile.allowedCapabilities))].sort();
  const allowedNetworkZones = profiles.map((profile) => new Set(profile.allowedNetworkZones))
    .reduce((a, b) => new Set([...a].filter((zone) => b.has(zone))));
  const requiredNetworkZones = [...new Set(profiles.flatMap((profile) => profile.requirements.networkZones))].sort();
  const requiredRuntimes = mergeExactConstraints(profiles.map((profile) => profile.requirements.runtimes));
  const maxConcurrency = Math.min(...profiles.map((profile) => profile.maxConcurrency));
  const requiredCapabilities = mergeExactConstraints(profiles.map((profile) => profile.requirements.capabilities));
  const minResources = mergeResourceMinimums(profiles.map((profile) => profile.requirements.minResources));
  const minimumIsolation = profiles.map((profile) => profile.requirements.minimumIsolation).filter((v): v is NonNullable<typeof v> => Boolean(v))
    .sort((a, b) => isolationRank[b] - isolationRank[a])[0];
  const tags = [...new Set(profiles.flatMap((profile) => profile.tags))].sort();

  if (override?.allowedCapabilities && override.allowedCapabilities.some((name) => !allowedCapabilities.includes(name))) {
    throw new Error('profile override cannot grant a capability outside the selected profiles');
  }
  if (override?.allowedNetworkZones && override.allowedNetworkZones.some((zone) => !allowedNetworkZones.has(zone))) {
    throw new Error('profile override cannot widen the allowed network zones');
  }
  if (override?.maxConcurrency !== undefined && override.maxConcurrency > maxConcurrency) {
    throw new Error('profile override cannot increase maximum concurrency');
  }
  for (const [name, value] of Object.entries(override?.requiredCapabilities ?? {})) {
    if (name in requiredCapabilities && requiredCapabilities[name] !== value) throw new Error(`profile override cannot replace requirement ${name}`);
  }
  const overrideResources = override?.minResources ? mergeResourceMinimums([minResources, override.minResources]) : minResources;
  const chosenIsolation = override?.minimumIsolation && (!minimumIsolation || isolationRank[override.minimumIsolation] > isolationRank[minimumIsolation])
    ? override.minimumIsolation : minimumIsolation;
  return {
    profileIds: profiles.map((profile) => profile.id).sort(),
    allowedCapabilities: override?.allowedCapabilities ? [...new Set(override.allowedCapabilities)].sort() : allowedCapabilities,
    allowedNetworkZones: override?.allowedNetworkZones ? [...new Set(override.allowedNetworkZones)].sort() : [...allowedNetworkZones].sort(),
    requiredNetworkZones,
    requiredRuntimes,
    maxConcurrency: override?.maxConcurrency ?? maxConcurrency,
    requiredCapabilities: mergeExactConstraints([requiredCapabilities, override?.requiredCapabilities ?? {}]),
    minResources: overrideResources,
    ...(chosenIsolation ? { minimumIsolation: chosenIsolation } : {}),
    tags,
  };
}

export type WorkerProfileMatch =
  | { schedulable: true; preferenceScore: number }
  | { schedulable: false; reason: 'stale' | 'policy-denied' | 'incompatible' | 'saturated'; missing: string[] };

/** Deterministic, explainable profile match; unknown/failed observations never satisfy requirements. */
export function matchWorkerProfile(
  inventory: WorkerInventory,
  request: WorkerProfileRequest,
  policy: WorkerProfilePolicy,
  options: { now?: number; isLocal?: boolean; localTags?: string[]; activeJobs?: number } = {},
): WorkerProfileMatch {
  const observed = Date.parse(inventory.observedAt);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(observed) || now > observed + inventory.freshForMs) return { schedulable: false, reason: 'stale', missing: ['inventory:stale'] };
  if (options.activeJobs !== undefined && options.activeJobs >= Math.min(inventory.maxConcurrency, policy.maxConcurrency, request.maxConcurrency ?? Number.MAX_SAFE_INTEGER)) {
    return { schedulable: false, reason: 'saturated', missing: ['concurrency:limit'] };
  }
  const missing: string[] = [];
  const denied = Object.keys(request.requiredCapabilities).filter((name) => !policy.allowedCapabilities.includes(name)).sort();
  if (denied.length) return { schedulable: false, reason: 'policy-denied', missing: denied.map((name) => `capability:${name}:denied`) };
  const conflicts = Object.entries(policy.requiredCapabilities).filter(([name, value]) => name in request.requiredCapabilities && request.requiredCapabilities[name] !== value).sort(([a], [b]) => a.localeCompare(b));
  if (conflicts.length) return { schedulable: false, reason: 'policy-denied', missing: conflicts.map(([name]) => `capability:${name}:conflicts-with-profile`) };
  if (request.networkZone && !policy.allowedNetworkZones.includes(request.networkZone)) {
    return { schedulable: false, reason: 'policy-denied', missing: [`network:${request.networkZone}:denied`] };
  }
  const absentProfiles = request.requiredProfiles.filter((id) => !policy.profileIds.includes(id));
  for (const id of absentProfiles) missing.push(`profile:${id}`);
  if (request.locality === 'require-local' && options.isLocal !== true) missing.push('locality:local-required');
  if (request.networkZone && !inventory.networkZones.includes(request.networkZone)) missing.push(`network:${request.networkZone}`);
  for (const [name, expected] of Object.entries(mergeExactConstraints([policy.requiredCapabilities, request.requiredCapabilities]))) {
    const observedCapability = inventory.capabilities[name];
    if (observedCapability?.status !== 'validated' || observedCapability.value !== expected) missing.push(`capability:${name}`);
  }
  for (const zone of policy.requiredNetworkZones) if (!inventory.networkZones.includes(zone)) missing.push(`network:${zone}`);
  for (const [name, version] of Object.entries(policy.requiredRuntimes)) if (inventory.runtimes[name] !== version) missing.push(`runtime:${name}@${version}`);
  const resourceNeeds = mergeResourceMinimums([policy.minResources, request.minResources]);
  for (const [name, amount] of Object.entries(resourceNeeds)) {
    if ((inventory.resources[name as keyof WorkerResourceQuantities] ?? 0) < amount!) missing.push(`resource:${name}`);
  }
  const isolation = request.minimumIsolation && (!policy.minimumIsolation || isolationRank[request.minimumIsolation] > isolationRank[policy.minimumIsolation])
    ? request.minimumIsolation : policy.minimumIsolation;
  if (isolation && !isolationAtLeast(inventory.isolation, isolation)) missing.push(`isolation:${isolation}`);
  for (const tag of request.affinityTags) if (!inventory.profileTags.includes(tag) && !policy.tags.includes(tag)) missing.push(`affinity:${tag}`);
  const deniedAffinity = request.antiAffinityTags.filter((tag) => inventory.profileTags.includes(tag) || policy.tags.includes(tag));
  for (const tag of deniedAffinity) missing.push(`anti-affinity:${tag}`);
  if (missing.length) return { schedulable: false, reason: 'incompatible', missing: [...missing].sort() };
  const localHits = request.affinityTags.filter((tag) => options.localTags?.includes(tag)).length;
  const preferenceScore = request.locality === 'prefer-local' ? localHits + (options.isLocal ? 1 : 0) : 0;
  return { schedulable: true, preferenceScore };
}

const noRequirements = { capabilities: {}, minResources: {}, networkZones: [], runtimes: {} };
export const BUILTIN_WORKER_PROFILES: WorkerProfileTemplate[] = [
  workerProfileTemplateSchema.parse({ schemaVersion: 1, id: 'general-compute', tags: ['general-compute'], requirements: noRequirements, allowedCapabilities: [], allowedNetworkZones: ['isolated', 'restricted', 'internet'], maxConcurrency: 4 }),
  workerProfileTemplateSchema.parse({ schemaVersion: 1, id: 'gui', tags: ['gui'], requirements: { ...noRequirements, capabilities: { 'display.capture': true }, minResources: { displaySlots: 1 } }, allowedCapabilities: ['display.capture'], allowedNetworkZones: ['isolated', 'restricted'], maxConcurrency: 1 }),
  workerProfileTemplateSchema.parse({ schemaVersion: 1, id: 'lightweight-network-peer', tags: ['network-peer'], requirements: { ...noRequirements, capabilities: { 'network.peer': true }, networkZones: ['restricted'] }, allowedCapabilities: ['network.peer'], allowedNetworkZones: ['restricted'], maxConcurrency: 2 }),
  workerProfileTemplateSchema.parse({ schemaVersion: 1, id: 'asset-enabled', tags: ['asset-enabled'], requirements: { ...noRequirements, capabilities: { 'storage.readonly': true } }, allowedCapabilities: ['storage.readonly'], allowedNetworkZones: ['isolated'], maxConcurrency: 1 }),
];
export const BUILTIN_WORKER_PROFILE_IDS = BUILTIN_WORKER_PROFILES.map((profile) => profile.id);
