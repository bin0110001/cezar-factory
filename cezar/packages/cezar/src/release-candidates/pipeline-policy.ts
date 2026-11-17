import { createHash } from 'node:crypto';
import { isValidTimeZone, occurrencesBetween, type AutomationSchedule } from '@open-mercato/cezar-contract';

/**
 * Release pipeline policy for the Control Center editor (#632): validation, the effective-config preview and the next-run dry run.
 *
 * The authority is `scripts/release/release_pipeline_config.py` (it is what the release engine reads). This is a port for previews, so
 * an operator sees the same errors and the same effective hash before saving. `tests/fixtures/release-pipeline-cases.json` is generated
 * by the Python authority and checked by both test suites: validity, error paths and the effective hash must agree.
 */

export const SCHEMA_VERSION = 'release-pipeline/v1';
type J = Record<string, unknown>;
const MODES = ['two-branch', 'three-branch'];
const STAGE_KINDS = ['integration', 'regression', 'stable'];
const FREQUENCIES = ['daily', 'weekly'];
const STABLE_KINDS = ['auto', 'approval'];
const REVIEW_KINDS = ['self-review', 'approval'];
const EMERGENCY = ['forward-port', 'cherry-pick', 'none'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function defaultSpec(): J {
  return {
    mode: 'two-branch',
    stages: [{ id: 'dev', branch: 'dev', kind: 'integration' }, { id: 'stable', branch: 'stable', kind: 'stable' }],
    triggers: { manual: true, afterChanges: { enabled: false } },
    admission: { maxActiveCandidates: 1 },
    tests: { suites: [], required: [] },
    candidateLifetimeHours: 72,
    repair: { maxAttempts: 3, backoffMinutes: 30 },
    promotion: { review: 'approval', stable: 'approval', soakMinutes: 0 },
    artifactRetentionDays: 30,
    notifications: { channels: [] },
    emergencyFix: { strategy: 'forward-port' },
  };
}

const THREE_STAGES = [{ id: 'dev', branch: 'dev', kind: 'integration' }, { id: 'regression', branch: 'regression', kind: 'regression' }, { id: 'stable', branch: 'stable', kind: 'stable' }];
export const PRESETS: Record<string, J> = {
  'weekly-calendar': { mode: 'three-branch', stages: THREE_STAGES, triggers: { manual: true, schedule: { frequency: 'weekly', timezone: 'America/Detroit' } } },
  'daily-calendar': { mode: 'three-branch', stages: THREE_STAGES, triggers: { manual: true, schedule: { frequency: 'daily', timezone: 'America/Detroit' } } },
};

const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T,>(v: T): T => structuredClone(v);

/** Deep merge: objects merge, everything else (lists, the stage graph) is replaced whole. */
export function merge(base: unknown, over: unknown): unknown {
  if (isObj(base) && isObj(over)) {
    const out: J = clone(base);
    for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : clone(v);
    return out;
  }
  return clone(over);
}

type Shape = { [k: string]: Shape | 'string' | 'integer' | 'boolean' | 'list' };
const SHAPE: Shape = {
  mode: 'string', stages: 'list',
  triggers: {
    manual: 'boolean',
    schedule: { frequency: 'string', dayOfWeek: 'string', hour: 'integer', minute: 'integer', timezone: 'string' },
    afterChanges: { enabled: 'boolean', minCommits: 'integer', minFiles: 'integer', paths: 'list', minElapsedHours: 'integer', maxDelayHours: 'integer', cooldownMinutes: 'integer', quietHours: { start: 'integer', end: 'integer', timezone: 'string' }, combinator: 'string' },
    missedRun: 'string', missedGraceMinutes: 'integer', priority: 'list',
  },
  admission: { maxActiveCandidates: 'integer' }, tests: { suites: 'list', required: 'list' }, candidateLifetimeHours: 'integer',
  repair: { maxAttempts: 'integer', backoffMinutes: 'integer' }, promotion: { review: 'string', stable: 'string', soakMinutes: 'integer' },
  artifactRetentionDays: 'integer', notifications: { channels: 'list' }, emergencyFix: { strategy: 'string' },
};

function unknownFields(spec: unknown, shape: Shape | string, path: string, errors: string[]): void {
  if (!isObj(spec) || typeof shape === 'string') return;
  for (const [key, value] of Object.entries(spec)) {
    if (key.startsWith('x-')) continue;
    const here = path ? `${path}.${key}` : key;
    const expected = shape[key];
    if (expected === undefined) { errors.push(`${here}: unknown field (extensions must start with 'x-')`); continue; }
    if (typeof expected === 'object') {
      if (!isObj(value)) errors.push(`${here}: must be an object`); else unknownFields(value, expected, here, errors);
    } else if (expected === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`${here}: must be an integer`);
    } else if (expected === 'string') { if (typeof value !== 'string') errors.push(`${here}: must be str`); }
    else if (expected === 'boolean') { if (typeof value !== 'boolean') errors.push(`${here}: must be bool`); }
    else if (!Array.isArray(value)) errors.push(`${here}: must be list`);
  }
}

const dig = (obj: unknown, ...path: string[]): unknown => {
  let cur: unknown = obj;
  for (const k of path) { if (!isObj(cur) || !(k in cur)) return undefined; cur = cur[k]; }
  return cur;
};
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function validateSpec(spec: J, where = 'spec'): string[] {
  const errors: string[] = [];
  unknownFields(spec, SHAPE, where, errors);
  if (errors.length > 0) return errors;
  const g = (...p: string[]) => dig(spec, ...p);
  const mode = g('mode');
  if (!MODES.includes(mode as string)) errors.push(`${where}.mode: must be one of ${JSON.stringify(MODES)}`);
  const stages = (g('stages') as unknown[] | undefined) ?? [];
  const ids = new Set<string>(); const branches = new Set<string>();
  stages.forEach((st, i) => {
    if (!isObj(st) || !['id', 'branch', 'kind'].every((k) => k in st)) { errors.push(`${where}.stages[${i}]: needs id, branch and kind`); return; }
    if (!STAGE_KINDS.includes(st.kind as string)) errors.push(`${where}.stages[${i}].kind: must be one of ${JSON.stringify(STAGE_KINDS)}`);
    const b = String(st.branch);
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(b) || b.includes('..') || b.startsWith('/') || b.startsWith('-')) errors.push(`${where}.stages[${i}].branch: not a safe branch name`);
    if (ids.has(String(st.id))) errors.push(`${where}.stages[${i}].id: duplicate stage id ${String(st.id)}`);
    if (branches.has(b)) errors.push(`${where}.stages[${i}].branch: branch/ref collision on ${b}`);
    ids.add(String(st.id)); branches.add(b);
  });
  const kinds = stages.filter(isObj).map((s) => s.kind);
  const want = mode === 'two-branch' ? ['integration', 'stable'] : mode === 'three-branch' ? ['integration', 'regression', 'stable'] : undefined;
  if (want && JSON.stringify(kinds) !== JSON.stringify(want)) errors.push(`${where}.stages: ${String(mode)} requires kinds ${JSON.stringify(want)}, got ${JSON.stringify(kinds)}`);

  const sched = g('triggers', 'schedule') as J | undefined;
  if (sched !== undefined) {
    if (!FREQUENCIES.includes(sched.frequency as string)) errors.push(`${where}.triggers.schedule.frequency: must be one of ${JSON.stringify(FREQUENCIES)}`);
    for (const f of ['hour', 'timezone']) if (!(f in sched)) errors.push(`${where}.triggers.schedule.${f}: required (not assumed by a preset)`);
    if ('hour' in sched && !(isInt(sched.hour) && sched.hour >= 0 && sched.hour <= 23)) errors.push(`${where}.triggers.schedule.hour: must be 0-23`);
    if ('minute' in sched && !(isInt(sched.minute) && sched.minute >= 0 && sched.minute <= 59)) errors.push(`${where}.triggers.schedule.minute: must be 0-59`);
    if ('timezone' in sched && !isValidTimeZone(String(sched.timezone))) errors.push(`${where}.triggers.schedule.timezone: unknown timezone ${String(sched.timezone)}`);
    if (sched.frequency === 'weekly' && !DAYS.includes(String(sched.dayOfWeek ?? '').toLowerCase())) errors.push(`${where}.triggers.schedule.dayOfWeek: required for weekly, one of ${JSON.stringify(DAYS)}`);
    if (sched.frequency === 'daily' && 'dayOfWeek' in sched) errors.push(`${where}.triggers.schedule.dayOfWeek: contradicts a daily frequency`);
  }
  const ac = (g('triggers', 'afterChanges') as J | undefined) ?? {};
  if (ac.enabled && !(ac.minCommits || ac.minFiles)) errors.push(`${where}.triggers.afterChanges: enabled needs minCommits or minFiles`);
  if (![undefined, 'skip', 'coalesce'].includes(g('triggers', 'missedRun') as string | undefined)) errors.push(`${where}.triggers.missedRun: must be 'skip' or 'coalesce'`);
  if (![undefined, 'any', 'all'].includes(ac.combinator as string | undefined)) errors.push(`${where}.triggers.afterChanges.combinator: must be 'any' or 'all'`);
  if (ac.paths !== undefined && !(ac.paths as unknown[]).every((x) => typeof x === 'string' && x)) errors.push(`${where}.triggers.afterChanges.paths: must be a list of non-empty globs`);
  const q = ac.quietHours as J | undefined;
  if (q !== undefined) {
    if (!['start', 'end'].every((k) => isInt(q[k]) && (q[k] as number) >= 0 && (q[k] as number) <= 23)) errors.push(`${where}.triggers.afterChanges.quietHours: start and end must be hours 0-23`);
    if ('timezone' in q && !isValidTimeZone(String(q.timezone))) errors.push(`${where}.triggers.afterChanges.quietHours.timezone: unknown timezone ${String(q.timezone)}`);
  }
  const prio = g('triggers', 'priority') as string[] | undefined;
  if (prio !== undefined && (prio.some((p) => !['schedule', 'change', 'manual'].includes(p)) || new Set(prio).size !== prio.length)) errors.push(`${where}.triggers.priority: must be unique values from schedule, change, manual`);
  if (mode === 'three-branch' && sched === undefined && !g('triggers', 'manual') && !ac.enabled) errors.push(`${where}.triggers: a three-branch pipeline needs at least one trigger`);

  if (g('admission', 'maxActiveCandidates') !== 1) errors.push(`${where}.admission.maxActiveCandidates: must be 1 (one active candidate per project)`);
  const suites = (g('tests', 'suites') as unknown[] | undefined) ?? [];
  const required = (g('tests', 'required') as unknown[] | undefined) ?? [];
  for (const [field, items] of [['suites', suites], ['required', required]] as const) {
    if (!items.every((x) => typeof x === 'string' && x)) errors.push(`${where}.tests.${field}: must be a list of non-empty strings`);
  }
  const missing = required.filter((r) => !suites.includes(r));
  if (missing.length > 0) errors.push(`${where}.tests.required: suites not declared in tests.suites: ${JSON.stringify(missing)}`);
  if (mode === 'three-branch' && required.length === 0) errors.push(`${where}.tests.required: a regression stage needs at least one required suite`);

  const review = g('promotion', 'review'); const stable = g('promotion', 'stable');
  if (!REVIEW_KINDS.includes(review as string)) errors.push(`${where}.promotion.review: must be one of ${JSON.stringify(REVIEW_KINDS)}`);
  if (!STABLE_KINDS.includes(stable as string)) errors.push(`${where}.promotion.stable: must be one of ${JSON.stringify(STABLE_KINDS)}`);
  if (stable === 'auto' && required.length === 0) errors.push(`${where}.promotion: stable 'auto' with no required suite is unsafe auto-promotion`);
  for (const [path, lo, hi] of [['candidateLifetimeHours', 1, 720], ['artifactRetentionDays', 1, 3650], ['repair.maxAttempts', 0, 20], ['repair.backoffMinutes', 0, 1440], ['promotion.soakMinutes', 0, 10080]] as const) {
    const v = g(...path.split('.'));
    if (!isInt(v) || v < lo || v > hi) errors.push(`${where}.${path}: must be an integer ${lo}-${hi}`);
  }
  if (!EMERGENCY.includes(g('emergencyFix', 'strategy') as string)) errors.push(`${where}.emergencyFix.strategy: must be one of ${JSON.stringify(EMERGENCY)}`);
  if (!((g('notifications', 'channels') as unknown[] | undefined) ?? []).every((c) => typeof c === 'string' && c)) errors.push(`${where}.notifications.channels: must be a list of non-empty strings`);
  return errors;
}

export class ConfigError extends Error { constructor(readonly errors: string[]) { super(errors.join('; ')); } }

export function resolve(doc: J, project: string | null): J {
  const errors: string[] = [];
  let spec = defaultSpec();
  const projects = isObj(doc.projects) ? doc.projects : {};
  const layers: Array<[string, unknown]> = [['defaults', doc.defaults ?? {}], [`projects.${project}`, project ? (projects[project] ?? {}) : {}]];
  for (const [label, raw] of layers) {
    if (!isObj(raw)) { errors.push(`${label}: must be an object`); continue; }
    const layer: J = { ...raw };
    const preset = layer.preset; delete layer.preset;
    if (preset !== undefined) {
      if (typeof preset === 'string' && PRESETS[preset]) spec = merge(spec, PRESETS[preset]) as J;
      else errors.push(`${label}.preset: unknown preset ${JSON.stringify(preset)}; known: ${JSON.stringify(Object.keys(PRESETS).sort())}`);
    }
    spec = merge(spec, layer) as J;
  }
  if (errors.length > 0) throw new ConfigError(errors);
  return spec;
}

export function validateDocument(doc: unknown): string[] {
  if (!isObj(doc)) return ['document: must be an object'];
  const m = /^release-pipeline\/v(\d+)$/.exec(String(doc.schemaVersion));
  if (!m) return [`schemaVersion: expected '${SCHEMA_VERSION}', got ${JSON.stringify(doc.schemaVersion)}`];
  if (Number(m[1]) > 1) return [`schemaVersion: ${JSON.stringify(doc.schemaVersion)} is newer than this reader supports (${SCHEMA_VERSION}); refusing to guess its fields`];
  const errors: string[] = [];
  for (const key of Object.keys(doc)) if (!['schemaVersion', 'defaults', 'projects'].includes(key) && !key.startsWith('x-')) errors.push(`${key}: unknown top-level field`);
  if (doc.projects !== undefined && !isObj(doc.projects)) { errors.push('projects: must be an object keyed by project id'); return errors; }
  if (errors.length > 0) return errors;
  const names: Array<string | null> = Object.keys((doc.projects as J | undefined) ?? {});
  if (names.length === 0) names.push(null);
  for (const name of names) {
    try { errors.push(...validateSpec(resolve(doc, name), name ? `projects.${name}` : 'defaults')); }
    catch (e) { if (e instanceof ConfigError) errors.push(...e.errors); else throw e; }
  }
  return errors;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, val) => (isObj(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : val));
export const configHash = (spec: J): string => `sha256:${createHash('sha256').update(canonical(spec)).digest('hex')}`;

export function effectiveConfig(doc: J, project: string | null): J {
  const errors = validateDocument(doc);
  if (errors.length > 0) throw new ConfigError(errors);
  return resolve(doc, project);
}

/** Error path = the text before the first colon, used to compare errors across languages without sharing prose. */
export const errorPath = (e: string): string => e.slice(0, e.indexOf(':') < 0 ? e.length : e.indexOf(':'));

/** The next `count` scheduled runs (UTC ISO strings), DST-correct, or [] when the spec has no calendar schedule. */
export function nextRuns(spec: J, from: Date, count = 3): string[] {
  const s = dig(spec, 'triggers', 'schedule') as J | undefined;
  if (!s || !isInt(s.hour) || typeof s.timezone !== 'string' || !isValidTimeZone(s.timezone)) return [];
  const day = DAYS.indexOf(String(s.dayOfWeek ?? '').toLowerCase()) + 1;
  const schedule: AutomationSchedule = s.frequency === 'weekly' ? { type: 'weekly', hour: s.hour, minute: isInt(s.minute) ? s.minute : 0, day: day || 1 } : { type: 'daily', hour: s.hour, minute: isInt(s.minute) ? s.minute : 0 };
  return occurrencesBetween(schedule, from.getTime(), from.getTime() + 60 * 86_400_000, s.timezone, count).map((ms) => new Date(ms).toISOString().replace('.000Z', 'Z'));
}
