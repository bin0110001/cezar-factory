import { isManifestStale, type ImpactManifest } from '../impact/manifest.ts';
import { ManifestStore } from '../impact/manifest-store.ts';
import { impactSnapshot } from '../../workspace/lifecycle.ts';
import type { BacklogStore } from './store.ts';
import { ObligationStore } from './integration-obligations.ts';
import { rankCandidates } from './ranking.ts';
import { DEFAULT_SCHEDULING_CONFIG, decideOne, type RunningWork, type SchedulingConfig, type SchedulingDecision } from './scheduling.ts';

/**
 * Bridge between the existing automation scheduler and the backlog decision pipeline (#198).
 * The scheduler's own dependency gate (#159) and quota gate (#93) stay authoritative and run first;
 * this hook adds the lane / hold / conflict / WIP view on top of their verdicts.
 *
 * Modes (env `CEZAR_BACKLOG_SCHEDULING`): unset/`off` = not installed; `shadow` = decide and record
 * but never block; `enforce` = a non-run decision defers the launch. Default is off, per project
 * kill switch = unset the variable.
 */
export type BacklogSchedulingMode = 'off' | 'shadow' | 'enforce';

export function backlogSchedulingMode(env: NodeJS.ProcessEnv = process.env): BacklogSchedulingMode {
  const v = (env.CEZAR_BACKLOG_SCHEDULING ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'enforce' ? v : 'off';
}

export interface BacklogAdmissionResult { allow: boolean; reason: string; shadow: boolean; decision: SchedulingDecision }
export type BacklogAdmissionCandidate = { number: number; labels: string[]; timestamp: string; /** Current head of the target branch, when known, for manifest freshness. */ baseSha?: string };
export type BacklogAdmissionCheck = (candidate: BacklogAdmissionCandidate) => Promise<BacklogAdmissionResult>;

export function createBacklogAdmission(options: {
  repository: string;
  store: BacklogStore;
  mode: Exclude<BacklogSchedulingMode, 'off'>;
  /** Work currently running in this repository (workspace registry snapshot); defaults to none. */
  running?: () => Promise<RunningWork[]> | RunningWork[];
  /** Impact manifest for the candidate when one exists. */
  manifest?: (issueNumber: number) => Promise<ImpactManifest | null> | ImpactManifest | null;
  config?: Partial<SchedulingConfig>;
  now?: () => Date;
  onDecision?: (decision: SchedulingDecision) => void;
}): BacklogAdmissionCheck {
  const config: SchedulingConfig = { ...DEFAULT_SCHEDULING_CONFIG, ...options.config, enforce: options.mode === 'enforce' };
  return async (candidate) => {
    const now = (options.now ?? (() => new Date()))();
    // Labels seed the projection once; later human edits are never overwritten (see store.ensureFromLabels).
    const { record } = options.store.ensureFromLabels(options.repository, candidate.number, { labels: candidate.labels, issueState: 'open' }, { now: now.toISOString() });
    const timers = options.store.timers(options.repository, candidate.number);
    const [ranked] = rankCandidates([{ record, createdAt: timers.createdAt ?? candidate.timestamp, expediteUntil: timers.expediteUntil, snoozeUntil: timers.snoozeUntil }], now);
    const manifest = await options.manifest?.(candidate.number) ?? null;
    // If running work cannot be read, fail closed: capacity is reported unknown (a distinct deferral), never "nothing running".
    let running: RunningWork[] = [];
    let runningKnown = true;
    try { running = (await options.running?.() ?? []).filter((r) => r.id !== ranked!.id); } catch { runningKnown = false; }
    const decision = decideOne({
      candidate: ranked!,
      // The scheduler already passed the #159 dependency gate and the #93 quota gate before this hook runs.
      dependency: { status: 'ready', blockers: [], graphRevision: 0 },
      capacity: { status: runningKnown ? 'available' : 'unknown' },
      manifest,
      ...(manifest && candidate.baseSha !== undefined ? { manifestStale: isManifestStale(manifest, candidate.baseSha) } : {}),
    }, running, config);
    options.onDecision?.(decision);
    const runnable = decision.kind === 'RUN' || decision.kind === 'BATCH' || decision.kind === 'COORDINATE' || decision.kind === 'INTEGRATE';
    return { allow: runnable || options.mode === 'shadow', reason: `${decision.reason}: ${decision.detail}`, shadow: options.mode === 'shadow', decision };
  };
}

let sharedStore: BacklogStore | undefined;
let sharedObligations: ObligationStore | undefined;
/** Process-wide projection store, created on first use so a disabled feature never touches disk. */
export async function sharedBacklogStore(): Promise<BacklogStore> {
  if (!sharedStore) {
    const { BacklogStore: Store } = await import('./store.ts');
    sharedStore = new Store();
  }
  return sharedStore;
}
export async function sharedObligationStore(): Promise<ObligationStore> {
  if (!sharedObligations) {
    const { cezarHomeDir } = await import('../../paths.ts');
    const { resolve } = await import('node:path');
    sharedObligations = new ObligationStore({ path: resolve(cezarHomeDir(), 'backlog', 'obligations.sqlite') });
  }
  return sharedObligations;
}
const manifests = new ManifestStore();

/** Live, unexpired workspace claims on this host, joined with their stored manifests. A read failure throws so the caller fails closed. */
export async function runningFromRegistry(root: string, repository: string, store: Pick<ManifestStore, 'get'>): Promise<RunningWork[]> {
  const snapshot = await impactSnapshot({ cwd: root });
  return snapshot.entries
    .filter((e) => !e.leaseExpired && ['working', 'validating', 'ready', 'integrating', 'blocked', 'recoverable'].includes(e.state))
    .map((e) => {
      const manifest = store.get(repository, Number(e.issue));
      return { id: `${repository}#${e.issue}`, repository, ...(manifest ? { manifest } : {}) };
    });
}
/** Build the hook for a GitHub project, or undefined when backlog scheduling is off (the default). */
export async function backlogAdmissionForProject(owner: string, repo: string, root?: string, env: NodeJS.ProcessEnv = process.env): Promise<BacklogAdmissionCheck | undefined> {
  const mode = backlogSchedulingMode(env);
  if (mode === 'off') return undefined;
  const store = await sharedBacklogStore();
  return createBacklogAdmission({
    repository: `${owner}/${repo}`, store, mode,
    manifest: (n) => manifests.get(`${owner}/${repo}`, n),
    ...(root ? { running: () => runningFromRegistry(root, `${owner}/${repo}`, manifests) } : {}),
    onDecision: (d) => { console.info(`[backlog-scheduling:${mode}] ${d.id} ${d.kind} ${d.reason} ${d.decisionKey}`); },
  });
}

/** Synchronous handle fragment: empty when off, otherwise a lazily-initialised hook. */
export function backlogAdmitFragment(owner: string, repo: string, root?: string, env: NodeJS.ProcessEnv = process.env): { backlogAdmit?: (candidate: BacklogAdmissionCandidate) => Promise<BacklogAdmissionResult> } {
  if (backlogSchedulingMode(env) === 'off') return {};
  return {
    backlogAdmit: async (candidate) => {
      const hook = await backlogAdmissionForProject(owner, repo, root, env);
      if (!hook) throw new Error('backlog scheduling was disabled while a launch was in flight');
      return hook(candidate);
    },
  };
}
