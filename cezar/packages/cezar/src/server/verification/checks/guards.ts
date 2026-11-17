import type { CheckDefinition } from './check-provider.js';

/**
 * Configuration guards for the check pipeline (#673).
 *
 * Duplicate-gate guard: two analyzers must not both be mandatory gates for the same category at the same trigger unless the
 * configuration says so explicitly. Two mandatory gates on one concern double-count a finding and let either provider's outage block
 * releases for the same reason. Swapping a provider is therefore replacing one definition, never adding a second gate.
 */

export interface DuplicateGateViolation { category: string; trigger: string; checks: string[] }

/** `allowedDuplicates` lists categories where two mandatory providers are deliberate (for example a cross-checking SCA pair). */
export function duplicateGateViolations(definitions: readonly CheckDefinition[], allowedDuplicates: readonly string[] = []): DuplicateGateViolation[] {
  const groups = new Map<string, string[]>();
  for (const d of definitions) {
    if (!d.policy.mandatory) continue;
    for (const trigger of d.triggers) {
      const key = `${d.category}\u0000${trigger}`;
      groups.set(key, [...(groups.get(key) ?? []), d.id]);
    }
  }
  return [...groups.entries()]
    .filter(([key, ids]) => ids.length > 1 && !allowedDuplicates.includes(key.split('\u0000')[0] ?? ''))
    .map(([key, ids]) => { const [category = '', trigger = ''] = key.split('\u0000'); return { category, trigger, checks: ids.sort() }; })
    .sort((a, b) => a.category.localeCompare(b.category) || a.trigger.localeCompare(b.trigger));
}

/** A provider swap replaces the definition for a category; history is kept because findings use the provider-independent fingerprint. */
export function swapProvider(definitions: readonly CheckDefinition[], checkId: string, provider: CheckDefinition['provider']): CheckDefinition[] {
  if (!definitions.some((d) => d.id === checkId)) throw new Error(`unknown check ${checkId}`);
  return definitions.map((d) => (d.id === checkId ? { ...d, provider } : d));
}
