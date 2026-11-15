// Recovery console contract. The Recovery view codes against this narrow client interface so wiring to the
// real controller read-model/action API (#70) is an adapter swap. Field names follow
// scripts/release/factory_incident_ledger.py (failure_class, fingerprint, attempt_count, next_attempt_at,
// escalated, candidate_sha, causal_evidence). No repair or secret logic lives here: every mutation is a call
// to RecoveryClient.submitAction, and success is whatever the backend receipt says.

export type RecoveryActionKind = 'retry' | 'reconcile' | 'quarantine' | 'rollback'
export type RecoverySeverity = 'info' | 'warning' | 'critical'
export type RecoveryScope = 'recovery:retry' | 'recovery:reconcile' | 'recovery:quarantine' | 'recovery:rollback'

export const ACTION_SCOPE: Record<RecoveryActionKind, RecoveryScope> = {
  retry: 'recovery:retry',
  reconcile: 'recovery:reconcile',
  quarantine: 'recovery:quarantine',
  rollback: 'recovery:rollback',
}
export const HIGH_RISK_ACTIONS: ReadonlySet<RecoveryActionKind> = new Set(['quarantine', 'rollback'])
export const ACTION_KINDS: readonly RecoveryActionKind[] = ['retry', 'reconcile', 'quarantine', 'rollback']

/** One ledger occurrence (an attempt row). */
export interface RecoveryOccurrence {
  failureClass: string
  fingerprint: string
  summary: string
  occurredAt: number
  attempt: number
  escalated: boolean
  projects: string[]
}

export interface RecoveryIncident {
  failureClass: string
  fingerprint: string
  summary: string
  status: 'open' | 'cooling-down' | 'escalated' | 'quarantined' | 'resolved'
  attemptCount: number
  nextAttemptAt: number | null
  escalated: boolean
  firstSeen: number
  lastSeen: number
  candidateSha: string | null
  causalEvidence: Record<string, string>
  affectedProjects: string[]
  priorRepairs: { id: string; outcome: string; prUrl?: string }[]
  generatedPrUrl: string | null
}

export interface RecoveryState {
  incidents: RecoveryIncident[]
  /** Scopes granted to the current user, reported by the backend. */
  grantedScopes: RecoveryScope[]
  /** Backend-reported conflicting activity (activation, another action). Null when none. */
  conflict: { kind: 'activation' | 'action'; detail: string } | null
}

export interface RecoveryActionRequest {
  action: RecoveryActionKind
  failureClass: string
  fingerprint: string
  /** Sent so a double submit or retry never runs the action twice. */
  idempotencyKey: string
}

/** The only authoritative outcome: the backend receipt/audit result. */
export interface RecoveryReceipt {
  idempotencyKey: string
  state: 'pending' | 'succeeded' | 'failed'
  auditId?: string
  message?: string
}

export interface RecoveryClient {
  load(): Promise<RecoveryState>
  submitAction(request: RecoveryActionRequest): Promise<RecoveryReceipt>
  /** Polls the receipt; the UI keeps showing progress until it is succeeded or failed. */
  getReceipt(idempotencyKey: string): Promise<RecoveryReceipt>
}

export interface AggregatedIncident extends RecoveryIncident {
  occurrenceCount: number
  severity: RecoverySeverity
}

export function severityFor(incident: RecoveryIncident, occurrences: number): RecoverySeverity {
  if (incident.escalated || incident.status === 'escalated') return 'critical'
  if (occurrences >= 3 || incident.attemptCount >= 2) return 'warning'
  return 'info'
}

/** Collapse incidents sharing a fingerprint (per class) into one entry; severity escalates with occurrences. */
export function aggregateIncidents(
  incidents: RecoveryIncident[],
  occurrences: RecoveryOccurrence[] = [],
): AggregatedIncident[] {
  const groups = new Map<string, RecoveryIncident[]>()
  for (const incident of incidents) {
    const key = `${incident.failureClass}:${incident.fingerprint}`
    groups.set(key, [...(groups.get(key) ?? []), incident])
  }
  const out: AggregatedIncident[] = []
  for (const [key, group] of groups) {
    const latest = group.reduce((a, b) => (b.lastSeen >= a.lastSeen ? b : a))
    const extra = occurrences.filter((o) => `${o.failureClass}:${o.fingerprint}` === key).length
    const merged: RecoveryIncident = {
      ...latest,
      firstSeen: Math.min(...group.map((i) => i.firstSeen)),
      attemptCount: Math.max(...group.map((i) => i.attemptCount)),
      escalated: group.some((i) => i.escalated),
      affectedProjects: [...new Set(group.flatMap((i) => i.affectedProjects))].sort(),
    }
    const occurrenceCount = Math.max(group.length, extra)
    out.push({ ...merged, occurrenceCount, severity: severityFor(merged, occurrenceCount) })
  }
  const rank: Record<RecoverySeverity, number> = { critical: 0, warning: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.lastSeen - a.lastSeen)
}

export interface ActionGate {
  enabled: boolean
  reason?: string
  needsConfirmation: boolean
}

export function gateAction(action: RecoveryActionKind, incident: RecoveryIncident, state: RecoveryState): ActionGate {
  const needsConfirmation = HIGH_RISK_ACTIONS.has(action)
  if (!state.grantedScopes.includes(ACTION_SCOPE[action])) {
    return { enabled: false, needsConfirmation, reason: `Requires the ${ACTION_SCOPE[action]} permission.` }
  }
  if (state.conflict) {
    return { enabled: false, needsConfirmation, reason: `Disabled while ${state.conflict.detail}` }
  }
  if (incident.status === 'resolved') {
    return { enabled: false, needsConfirmation, reason: 'This incident is already resolved.' }
  }
  if (incident.status === 'quarantined' && action !== 'rollback') {
    return { enabled: false, needsConfirmation, reason: 'This incident is quarantined.' }
  }
  return { enabled: true, needsConfirmation }
}

export function newIdempotencyKey(): string {
  const c = globalThis.crypto
  return c?.randomUUID ? c.randomUUID() : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Fixture adapter used until the controller API (#70) is wired; deterministic and side-effect free. */
export function createFixtureRecoveryClient(state: RecoveryState): RecoveryClient {
  const receipts = new Map<string, RecoveryReceipt>()
  return {
    load: async () => state,
    submitAction: async (request) => {
      const existing = receipts.get(request.idempotencyKey)
      if (existing) return existing
      const receipt: RecoveryReceipt = { idempotencyKey: request.idempotencyKey, state: 'succeeded', auditId: `audit-${receipts.size + 1}` }
      receipts.set(request.idempotencyKey, receipt)
      return receipt
    },
    getReceipt: async (key) => receipts.get(key) ?? { idempotencyKey: key, state: 'failed', message: 'Unknown receipt.' },
  }
}
