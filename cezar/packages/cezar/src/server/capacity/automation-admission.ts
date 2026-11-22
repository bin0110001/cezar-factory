import { loadConfig } from '../../config.ts';
import { readAgentModelSettings } from '../../agent-config/models.ts';
import { normalizeModelForBackend, ModelIdentityError } from '../../core/model-identity.ts';
import type { RunnerId } from '../../core/agent-runner.ts';
import { loadModelRoutingConfig, loadQuotaAdmissionPolicy, loadSubscriptionCapacityProfiles } from './config.ts';
import { QuotaAdmissionStore } from './quota-admission-store.ts';
import type { GithubAutomationDefinition } from '../../automations/types.ts';
import { capacityAdapterForRunner, evaluateCapacityProfile } from './quota-admission.ts';
import { loadAgentAccounts, selectionFor } from '../../workspace/agent-accounts.ts';

const admissionStore = new QuotaAdmissionStore();

/** Admit one automation receipt against host-local subscription profiles. */
export async function admitAutomationCapacity(
  root: string,
  definition: GithubAutomationDefinition,
  jobId: string,
): Promise<{ status: 'admitted'; leaseId?: string; profileId?: string; agentAccountId?: string; model?: string } | { status: 'deferred'; reason: string; retryAt?: string }> {
  const profiles = await loadSubscriptionCapacityProfiles();
  if (!profiles.size) return { status: 'admitted' };
  const policy = await loadQuotaAdmissionPolicy();
  const config = await loadConfig(root);
  const backend = (definition.task.runner ?? config.defaultRunner) as RunnerId;
  const modelSettings = await readAgentModelSettings(backend, root).catch(() => ({ provider: undefined, model: undefined }));
  const configuredProvider = modelSettings.provider;
  const routing = await loadModelRoutingConfig(root);
  const requested = definition.task.model ?? modelSettings.model;
  const tier = requested ? routing?.tiers?.[requested] : undefined;
  const tierAliases = tier?.fallback === 'none' ? tier.candidates.slice(0, 1) : tier?.candidates;
  const routeCandidates = tier && tierAliases
    ? tierAliases.filter(alias => {
      const model = routing!.models[alias]!;
      const features = model.features ?? {};
      const requirement = tier.require ?? {};
      return (!tier.providerAllow?.length || tier.providerAllow.includes(model.provider))
        && !tier.providerDeny?.includes(model.provider)
        && (tier.minQuality === undefined || Number(features.quality ?? 0) >= tier.minQuality)
        && (!requirement.tools || features.tools === true)
        && (!requirement.multimodal || features.multimodal === true)
        && (requirement.minContextTokens === undefined || Number(features.contextTokens ?? 0) >= requirement.minContextTokens)
        && (requirement.minCoding === undefined || Number(features.coding ?? 0) >= requirement.minCoding)
        && (requirement.minReasoning === undefined || Number(features.reasoning ?? 0) >= requirement.minReasoning)
        && (!requirement.locality || features.locality === requirement.locality);
    }).map(alias => {
      const model = routing!.models[alias]!;
      return { provider: model.provider, model: model.modelId };
    })
    : requested && routing?.models[requested]
      ? [{ provider: routing.models[requested]!.provider, model: routing.models[requested]!.modelId }]
      : [requested];
  const identities: Array<{ provider: string; model: string }> = [];
  for (const model of routeCandidates) {
    try {
      const modelValue = typeof model === 'string' ? model : model ? `${model.provider}/${model.model}` : undefined;
      const normalized = normalizeModelForBackend(backend, modelValue, { configuredProvider });
      if (normalized?.identity && !identities.some(item => item.provider === normalized.identity!.provider && item.model === normalized.identity!.model)) {
        identities.push(normalized.identity);
      }
    } catch (error) {
      if (!(error instanceof ModelIdentityError)) throw error;
    }
  }
  if (!identities.length) {
    if (tier) throw new Error(`automation model tier "${requested}" has no eligible candidate for ${backend}`);
    if (requested) throw new Error(`automation model "${requested}" could not be resolved for ${backend}`);
    const result = await admissionStore.transact(controller => controller.deferUnknownModel(jobId));
    return result.status === 'deferred'
      ? { status: 'deferred', reason: result.reason, retryAt: result.retryAt === undefined ? undefined : new Date(result.retryAt).toISOString() }
      : { status: 'deferred', reason: 'model-identity-unknown' };
  }
  const accountStore = await loadAgentAccounts();
  const pinnedAccountId = definition.task.agentProfile ?? selectionFor(accountStore, root, backend);
  const candidates = new Map([...profiles].filter(([, profile]) => {
    const adapter = capacityAdapterForRunner(backend);
    const providerMatches = identities.some(identity => profile.provider === identity.provider || profile.provider === backend);
    return profile.enabled && Boolean(profile.agentAccountId) && providerMatches
      && (!profile.adapters?.length || profile.adapters.includes(adapter))
      && identities.some(identity => (profile.provider === identity.provider || profile.provider === backend) && profile.allowedModelIds.includes(identity.model))
      && (!pinnedAccountId || profile.agentAccountId === pinnedAccountId);
  }));
  const routed = identities.flatMap(identity => [...candidates.values()]
    .filter(profile => (profile.provider === identity.provider || profile.provider === backend) && profile.allowedModelIds.includes(identity.model))
    .sort((a, b) => {
      const affinity = tier?.accountAffinity ?? [];
      const aAffinity = affinity.indexOf(a.id);
      const bAffinity = affinity.indexOf(b.id);
      const aRank = capacityStateRank(evaluateCapacityProfile(a, Date.now()));
      const bRank = capacityStateRank(evaluateCapacityProfile(b, Date.now()));
      return (aAffinity < 0 ? Infinity : aAffinity) - (bAffinity < 0 ? Infinity : bAffinity)
        || aRank - bRank || a.id.localeCompare(b.id);
    })
    .map(profile => ({ profileId: profile.id, provider: profile.provider, modelId: identity.model, estimatedCost: {} })));
  const result = await admissionStore.transact(controller => controller.admit(jobId, routed, candidates, {
    unknownMode: policy.unknownMode,
    optimisticUnknownLimit: policy.optimisticUnknownLimit,
  }));
  if (result.status === 'deferred') {
    return { status: 'deferred', reason: result.reason, retryAt: result.retryAt === undefined ? undefined : new Date(result.retryAt).toISOString() };
  }
  if (result.status !== 'admitted') throw new Error(`automation quota admission has no eligible account: ${result.reason}`);
  const profile = candidates.get(result.reservation.profileId)!;
  const selectedModel = identities.find(identity => identity.model === result.reservation.modelId
    && (profile.provider === identity.provider || profile.provider === backend));
  return {
    status: 'admitted', leaseId: jobId, profileId: profile.id,
    agentAccountId: profile.agentAccountId,
    ...(selectedModel ? { model: `${selectedModel.provider}/${selectedModel.model}` } : {}),
  };
}

function capacityStateRank(state: string): number {
  return ({ available: 0, constrained: 1, unknown: 2, stale: 3, exhausted: 4, disabled: 5 } as Record<string, number>)[state] ?? 6;
}

export async function releaseAutomationCapacity(leaseId: string): Promise<void> {
  await admissionStore.transact(controller => controller.release(leaseId));
}

export async function heartbeatAutomationCapacity(leaseId: string): Promise<void> {
  await admissionStore.transact(controller => controller.heartbeat(leaseId));
}

export async function reportAutomationRateLimit(leaseId: string, retryAfterSeconds?: number): Promise<void> {
  await admissionStore.transact(controller => controller.reportLeaseRateLimit(leaseId, retryAfterSeconds));
}
