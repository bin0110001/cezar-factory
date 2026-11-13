import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The Factory's issue lifecycle as the stall detector needs it: which `factory:*` labels are lifecycle states,
 * which of them a person owns, and which mean work is in flight.
 *
 * The Factory defines its process in `policies/lifecycle.json` (profiles that may extend one another). Reading it
 * here keeps the detector in step with the process: a state a profile adds, such as a sign-off gate, is a known
 * state owned by a person instead of an issue "with no state label". Nothing is required of a project: when the
 * policy cannot be found or read, `DEFAULT_LIFECYCLE` (the standard process) applies.
 */
export interface LifecycleKinds {
  /** Every state label any profile defines. */
  readonly stateLabels: ReadonlySet<string>;
  /** States a person owns (kind `human`), apart from `factory:blocked`, which the detector handles on its own. */
  readonly humanWait: ReadonlySet<string>;
  /** States where an automation or person is mid-flow: kind `in-run` or `delivery`, or flagged `inFlight`. */
  readonly inFlight: ReadonlySet<string>;
}

const BLOCKED = 'factory:blocked';

const IN_FLIGHT = ['factory:working', 'factory:implemented', 'factory:pr-open', 'factory:review', 'factory:changes-requested'] as const;
const HUMAN_WAIT = ['factory:needs-help', 'factory:human-review'] as const;

/** The standard process, used whenever the Factory policy is not available. */
export const DEFAULT_LIFECYCLE: LifecycleKinds = {
  stateLabels: new Set(['factory:new', 'factory:investigate', 'factory:needs-plan', 'factory:ready', ...IN_FLIGHT, ...HUMAN_WAIT, BLOCKED, 'factory:done']),
  humanWait: new Set(HUMAN_WAIT),
  inFlight: new Set(IN_FLIGHT),
};

const stateSchema = z.object({ kind: z.string(), inFlight: z.boolean().optional() }).passthrough();
const profileSchema = z.object({ extends: z.string().optional(), states: z.record(z.string(), stateSchema).optional() }).passthrough();
const policySchema = z.object({ profiles: z.record(z.string(), profileSchema) }).passthrough();
type Profile = z.infer<typeof profileSchema>;
type State = z.infer<typeof stateSchema>;

/** A profile's states with its `extends` chain applied: a state the child restates replaces the base's. */
function resolveStates(profiles: Record<string, Profile>, name: string, depth = 0): Record<string, State> {
  const profile = profiles[name];
  if (!profile || depth > 5) return {};
  const base = profile.extends ? resolveStates(profiles, profile.extends, depth + 1) : {};
  return { ...base, ...(profile.states ?? {}) };
}

/**
 * Derive the lifecycle kinds from the parsed policy. Every profile counts: a project may run any of them, and an
 * issue sitting in a state that only one profile defines is still in a known state. The first profile to define a
 * label decides its kind, and `standard` comes first in the shipped file.
 */
export function lifecycleFromPolicy(raw: unknown): LifecycleKinds | undefined {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const kinds = new Map<string, State>();
  for (const name of Object.keys(parsed.data.profiles)) {
    for (const [label, state] of Object.entries(resolveStates(parsed.data.profiles, name))) if (!kinds.has(label)) kinds.set(label, state);
  }
  if (kinds.size === 0) return undefined;
  const stateLabels = new Set(kinds.keys());
  const humanWait = new Set<string>();
  const inFlight = new Set<string>();
  for (const [label, state] of kinds) {
    if (state.kind === 'human' && label !== BLOCKED) humanWait.add(label);
    if (state.kind === 'in-run' || state.kind === 'delivery' || state.inFlight === true) inFlight.add(label);
  }
  return { stateLabels, humanWait, inFlight };
}

/** Where a project keeps the policy: the Factory checkout itself, or a managed project's installed copy. */
export function lifecyclePolicyPaths(projectRoot: string): string[] {
  return [join(projectRoot, 'policies', 'lifecycle.json'), join(projectRoot, '.ai', 'factory', 'policies', 'lifecycle.json')];
}

/** The project's lifecycle, or `undefined` (use `DEFAULT_LIFECYCLE`) when no readable, valid policy exists. */
export function loadLifecycleKinds(projectRoot: string): LifecycleKinds | undefined {
  for (const path of lifecyclePolicyPaths(projectRoot)) {
    try {
      const kinds = lifecycleFromPolicy(JSON.parse(readFileSync(path, 'utf8')));
      if (kinds) return kinds;
    } catch {
      // missing or unreadable: try the next location, then fall back to the standard process
    }
  }
  return undefined;
}
