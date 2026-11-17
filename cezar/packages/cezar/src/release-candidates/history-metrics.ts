import { existsSync, readFileSync } from 'node:fs';
import type { Candidate, ProjectMetrics, ReleaseCandidatesResponse, ReleaseHistoryResponse, ReleaseMetricsResponse } from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { actionsPath } from './actions.ts';
import { waiversPath } from './quality-actions.ts';
import { effectiveConfig } from './pipeline-policy.ts';
import { loadPolicyDocument, policyAuditPath, policyPath } from './pipeline-policy-store.ts';

/**
 * History, audit browsing and metrics for the Control Center (#635). History merges the operator-action and policy-change audit logs
 * and the candidate list, newest first, and respects each project's retention window (its `artifactRetentionDays`, default 30).
 * Metrics are computed only from the read-model data: a figure with no recorded inputs is `null` with zero samples, never an estimate.
 */

const HOUR = 3_600_000;
const MIN = 60_000;
const TERMINAL = new Set(['promoted', 'abandoned', 'failed', 'canceled']);
const DEFAULT_RETENTION_DAYS = 30;
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100);
const round = (n: number) => Math.round(n * 100) / 100;

export function computeMetrics(model: ReleaseCandidatesResponse, now: Date): ReleaseMetricsResponse {
  const projects: ProjectMetrics[] = model.projects.map((p) => {
    const all: Candidate[] = [...(p.active ? [p.active] : []), ...p.history];
    const waits = all.flatMap((c) => (c.timing?.queuedAt && c.timing.admittedAt ? [(Date.parse(c.timing.admittedAt) - Date.parse(c.timing.queuedAt)) / MIN] : [])).filter((n) => n >= 0);
    const costs = all.flatMap((c) => (c.cost ? [c.cost.computeSeconds / 3600] : []));
    const unresolved = all.flatMap((c) => c.repairObligations.filter((o) => (o.state === 'pending' || o.state === 'conflict') && o.openedAt));
    const promotions = all.flatMap((c) => c.receipts.filter((r) => r.kind === 'promotion' && r.ok).map((r) => Date.parse(r.at)));
    return {
      projectId: p.projectId,
      queueWaitMinutes: { mean: mean(waits), max: waits.length ? round(Math.max(...waits)) : null, samples: waits.length },
      suiteCostHours: { total: costs.length ? round(costs.reduce((a, b) => a + b, 0)) : null, mean: mean(costs), samples: costs.length },
      regressions: { candidatesWithRepair: all.filter((c) => c.revision > 1).length, candidates: all.length },
      forwardPortLagHours: { oldest: unresolved.length ? round(Math.max(...unresolved.map((o) => (now.getTime() - Date.parse(o.openedAt as string)) / HOUR))) : null, unresolved: all.reduce((n, c) => n + c.repairObligations.filter((o) => o.state === 'pending' || o.state === 'conflict').length, 0) },
      stableAgeHours: promotions.length ? round((now.getTime() - Math.max(...promotions)) / HOUR) : null,
      scheduledChecks: { runs: p.scheduledChecks.length, failing: p.scheduledChecks.filter((r) => r.status === 'fail' || r.status === 'error').length, lastRanAt: p.scheduledChecks[0]?.ranAt ?? null },
      aiAudit: { ran: p.aiAudit.filter((a) => a.outcome === 'ran').length, skipped: p.aiAudit.filter((a) => a.outcome === 'skipped').length, costUsd: round(p.aiAudit.reduce((n, a) => n + a.costUsd, 0)), tokens: p.aiAudit.reduce((n, a) => n + a.tokens, 0) },
    };
  });
  return { schemaVersion: 1, generatedAt: now.toISOString(), available: model.available, projects };
}

const readJsonl = (path: string): Array<Record<string, unknown>> => {
  if (!existsSync(path)) return [];
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  // One damaged line must not hide the rest of an audit log.
  return text.split('\n').filter(Boolean).flatMap((line) => { try { const v = JSON.parse(line) as unknown; return v && typeof v === 'object' ? [v as Record<string, unknown>] : []; } catch { return []; } });
};

/** Retention window per project from the saved policy; an invalid or missing policy uses the default. */
export function retentionByProject(projectIds: readonly string[], policyFile = policyPath()): Record<string, number> {
  const doc = loadPolicyDocument(policyFile);
  const out: Record<string, number> = {};
  for (const id of projectIds) {
    try { const days = effectiveConfig(doc, id).artifactRetentionDays; out[id] = typeof days === 'number' && days >= 1 ? days : DEFAULT_RETENTION_DAYS; } catch { out[id] = DEFAULT_RETENTION_DAYS; }
  }
  return out;
}

export function buildHistory(model: ReleaseCandidatesResponse, now: Date, files: { actions?: string; policyAudit?: string; policy?: string; waivers?: string } = {}): ReleaseHistoryResponse {
  const secrets = collectSecretValues();
  const actions = readJsonl(files.actions ?? actionsPath());
  const policy = readJsonl(files.policyAudit ?? policyAuditPath());
  const waivers = readJsonl(files.waivers ?? waiversPath());
  const ids = [...new Set([...model.projects.map((p) => p.projectId), ...actions.map((a) => String(a.projectId)), ...policy.map((a) => String(a.projectId)), ...waivers.map((a) => String(a.projectId))])];
  const retention = retentionByProject(ids, files.policy);
  const within = (project: string, at: string) => now.getTime() - Date.parse(at) <= (retention[project] ?? DEFAULT_RETENTION_DAYS) * 86_400_000;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const hashOrNull = (v: unknown) => (typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v) ? v : null);

  const entries: ReleaseHistoryResponse['entries'] = [
    ...actions.flatMap((a) => (str(a.at) && Date.parse(str(a.at)) && within(str(a.projectId), str(a.at))
      ? [{ id: str(a.id), at: new Date(str(a.at)).toISOString(), kind: 'operator-action' as const, projectId: str(a.projectId), actor: str(a.actor) || 'unknown',
        summary: redactSecrets(`${str(a.action)}${a.candidateId ? ` ${str(a.candidateId)}` : ''}: ${str(a.reason)}`, secrets).slice(0, 300), candidateId: a.candidateId ? str(a.candidateId) : null, beforeHash: null, afterHash: null }]
      : [])),
    ...waivers.flatMap((a) => (str(a.at) && Date.parse(str(a.at)) && within(str(a.projectId), str(a.at))
      ? [{ id: str(a.id), at: new Date(str(a.at)).toISOString(), kind: 'waiver' as const, projectId: str(a.projectId), actor: str(a.actor) || 'unknown',
        summary: redactSecrets(`waiver requested until ${str(a.expiresAt).slice(0, 10)}: ${str(a.reason)}`, secrets).slice(0, 300), candidateId: a.candidateId ? str(a.candidateId) : null, beforeHash: null, afterHash: null }]
      : [])),
    ...policy.flatMap((a) => (str(a.at) && Date.parse(str(a.at)) && within(str(a.projectId), str(a.at))
      ? [{ id: str(a.id), at: new Date(str(a.at)).toISOString(), kind: 'policy-change' as const, projectId: str(a.projectId), actor: str(a.actor) || 'unknown',
        summary: redactSecrets(`policy changed: ${str(a.reason)}`, secrets).slice(0, 300), candidateId: null, beforeHash: hashOrNull(a.beforeHash), afterHash: hashOrNull(a.afterHash) }]
      : [])),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)).slice(0, 500);

  const candidates = model.projects.flatMap((p) => [...(p.active ? [p.active] : []), ...p.history]
    .filter((c) => TERMINAL.has(c.state) ? within(p.projectId, c.updatedAt) : true)
    .map((c) => ({ projectId: p.projectId, id: c.id, state: c.state, revision: c.revision, createdAt: c.createdAt, updatedAt: c.updatedAt })))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 500);

  return { schemaVersion: 1, generatedAt: now.toISOString(), retentionDays: retention, entries, candidates };
}
