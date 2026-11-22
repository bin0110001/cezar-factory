import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cezarHomeDir } from '../../paths.ts';
import { loadAgentAccounts } from '../../workspace/agent-accounts.ts';
import { DEFAULT_AGENT_ACCOUNT_ID } from '../../workspace/agent-accounts.ts';
import type { SubscriptionCapacityProfile } from './quota-admission.ts';

interface ProfileFile {
  schemaVersion: number;
  profiles: Array<SubscriptionCapacityProfile & { credentialRef: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read private host-level capacity profiles. Credential references are resolved to Cezar agent
 * account IDs and immediately discarded; this return value is safe to pass into admission logic. */
export async function loadSubscriptionCapacityProfiles(
  path = join(cezarHomeDir(), 'subscription-profiles.json'),
): Promise<Map<string, SubscriptionCapacityProfile>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new Error('subscription capacity profiles could not be read; refusing quota-based dispatch');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 2 || !Array.isArray(parsed.profiles)) {
    throw new Error('subscription capacity profiles have an unsupported schema; refusing quota-based dispatch');
  }
  const accounts = await loadAgentAccounts();
  const accountIndex = new Map(accounts.accounts.map((account) => [account.id, account]));
  const result = new Map<string, SubscriptionCapacityProfile>();
  for (const raw of parsed.profiles) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.provider !== 'string'
      || typeof raw.credentialRef !== 'string' || typeof raw.enabled !== 'boolean'
      || !Number.isInteger(raw.maxConcurrency) || (raw.maxConcurrency as number) < 1
      || !Array.isArray(raw.allowedModelIds) || !raw.allowedModelIds.every((value) => typeof value === 'string')
      || !Array.isArray(raw.windows) || !raw.windows.every((window) => isRecord(window)
        && typeof window.name === 'string' && window.name.length > 0
        && ['rolling', 'fixed'].includes(String(window.kind))
        && typeof window.durationSeconds === 'number' && window.durationSeconds > 0
        && ['exact', 'estimated', 'unknown'].includes(String(window.confidence))
        && ['native', 'manual', 'observed', 'unsupported'].includes(String(window.source))
        && ['limit', 'remaining'].every((key) => window[key] === null || typeof window[key] === 'number')
        && ['resetAt', 'observedAt'].every((key) => window[key] === null || typeof window[key] === 'string'))
      || typeof raw.accountLabel !== 'string' || !raw.accountLabel
      || !Array.isArray(raw.adapters) || !raw.adapters.every((adapter) => typeof adapter === 'string')) {
      throw new Error('subscription capacity profile is malformed; refusing quota-based dispatch');
    }
    const ref = /^credstore:([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9-]{0,63})$/.exec(raw.credentialRef);
    const account = ref && ref[1] === raw.provider ? accountIndex.get(ref[2]!) : undefined;
    const accountId = ref && ref[1] === raw.provider && (account?.provider === raw.provider || ref[2] === DEFAULT_AGENT_ACCOUNT_ID)
      ? ref[2] : undefined;
    const profile: SubscriptionCapacityProfile = {
      id: raw.id,
      provider: raw.provider,
      adapters: raw.adapters as string[],
      enabled: raw.enabled,
      maxConcurrency: raw.maxConcurrency as number,
      allowedModelIds: raw.allowedModelIds as string[],
      windows: raw.windows as SubscriptionCapacityProfile['windows'],
      agentAccountId: accountId,
    };
    if (result.has(profile.id)) throw new Error('subscription capacity profiles contain duplicate IDs');
    result.set(profile.id, profile);
  }
  return result;
}

export interface ModelRoutingConfig {
  schemaVersion: 1;
  models: Record<string, { provider: string; modelId: string; features?: Record<string, unknown> }>;
  tiers?: Record<string, {
    candidates: string[];
    require?: { tools?: boolean; multimodal?: boolean; minContextTokens?: number; minCoding?: number; minReasoning?: number; locality?: 'local' | 'remote' };
    providerAllow?: string[];
    providerDeny?: string[];
    accountAffinity?: string[];
    fallback?: 'allow' | 'none';
    minQuality?: number;
  }>;
}

export interface QuotaAdmissionPolicyConfig {
  schemaVersion: 1;
  unknownMode: 'conservative' | 'optimistic';
  optimisticUnknownLimit: number;
}

export async function loadQuotaAdmissionPolicy(
  path = join(cezarHomeDir(), 'quota-admission-policy.json'),
): Promise<QuotaAdmissionPolicyConfig> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, unknownMode: 'conservative', optimisticUnknownLimit: 1 };
    throw new Error('quota admission policy could not be read; refusing quota-based dispatch');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1
    || !['conservative', 'optimistic'].includes(String(parsed.unknownMode))
    || !Number.isInteger(parsed.optimisticUnknownLimit) || (parsed.optimisticUnknownLimit as number) < 1
    || (parsed.optimisticUnknownLimit as number) > 10) {
    throw new Error('quota admission policy is malformed; refusing quota-based dispatch');
  }
  return parsed as unknown as QuotaAdmissionPolicyConfig;
}

/** Project-owned model preferences are optional; absent config leaves existing pinned dispatch alone. */
export async function loadModelRoutingConfig(
  repoRoot: string,
): Promise<ModelRoutingConfig | undefined> {
  const path = join(repoRoot, 'config', 'model-routing.json');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('model routing config could not be read; refusing routed dispatch');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.models) || !isRecord(parsed.tiers ?? {})) {
    throw new Error('model routing config is malformed; refusing routed dispatch');
  }
  const models = parsed.models;
  for (const [alias, rawModel] of Object.entries(parsed.models)) {
    if (!isRecord(rawModel) || typeof rawModel.provider !== 'string' || typeof rawModel.modelId !== 'string') {
      throw new Error(`model routing entry "${alias}" is malformed`);
    }
  }
  for (const [name, rawTier] of Object.entries(parsed.tiers ?? {})) {
    if (!isRecord(rawTier) || !Array.isArray(rawTier.candidates)
      || !rawTier.candidates.length || !rawTier.candidates.every((candidate) => typeof candidate === 'string')
      || rawTier.candidates.some((candidate) => !(candidate in models))
      || !['providerAllow', 'providerDeny', 'accountAffinity'].every((key) => rawTier[key] === undefined
        || (Array.isArray(rawTier[key]) && (rawTier[key] as unknown[]).every(value => typeof value === 'string')))
      || (rawTier.fallback !== undefined && !['allow', 'none'].includes(String(rawTier.fallback)))
      || (rawTier.minQuality !== undefined && (typeof rawTier.minQuality !== 'number' || !Number.isFinite(rawTier.minQuality) || rawTier.minQuality < 0))
      || (rawTier.require !== undefined && !isRecord(rawTier.require))) {
      throw new Error(`model routing tier "${name}" is malformed`);
    }
    const overlap = new Set((rawTier.providerAllow as string[] | undefined) ?? []);
    if (((rawTier.providerDeny as string[] | undefined) ?? []).some(provider => overlap.has(provider))) {
      throw new Error(`model routing tier "${name}" allows and denies the same provider`);
    }
  }
  return parsed as unknown as ModelRoutingConfig;
}
