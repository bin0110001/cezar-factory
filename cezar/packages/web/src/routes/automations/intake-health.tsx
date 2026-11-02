import type { AutomationListEntry, AutomationLogRecord } from '@open-mercato/cezar-api-client'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'
import { logTime } from '@/lib/automation-format'

/** One issue the intake holds back: its newest log row says `deferred` and nothing launched since. */
export interface WaitingCandidate {
  receiptId: string
  githubNumber?: number
  githubTitle?: string
  githubUrl?: string
  reason: string
}

export interface IntakeSummary {
  launched: number
  duplicates: number
  errors: number
  waiting: WaitingCandidate[]
}

/**
 * Explains the intake from the execution log alone (newest first, as the server returns it): a
 * receipt is "waiting" when its newest row is `deferred`, so a later `launched` row for the same
 * receipt takes it off the list. No extra request, no state to drift from the log.
 */
export function summarizeIntake(records: readonly AutomationLogRecord[]): IntakeSummary {
  const newestPerReceipt = new Map<string, AutomationLogRecord>()
  const summary: IntakeSummary = { launched: 0, duplicates: 0, errors: 0, waiting: [] }
  for (const record of records) {
    if (record.result === 'launched') summary.launched += 1
    else if (record.result === 'duplicate') summary.duplicates += 1
    else if (record.result === 'error' || record.result === 'failed') summary.errors += 1
    if (record.receiptId !== undefined && !newestPerReceipt.has(record.receiptId)) newestPerReceipt.set(record.receiptId, record)
  }
  for (const [receiptId, record] of newestPerReceipt) {
    if (record.result !== 'deferred') continue
    summary.waiting.push({
      receiptId,
      githubNumber: record.githubNumber,
      githubTitle: record.githubTitle,
      githubUrl: record.githubUrl,
      reason: record.reason ?? 'Awaiting admission.',
    })
  }
  return summary
}

/** Plain-language reason code for a deferral, so an operator can read why an issue has not run. */
export function deferralLabel(reason: string): string {
  if (reason.startsWith('admission-cap')) return 'Admission limit'
  if (reason.startsWith('no-longer-eligible')) return 'No longer eligible'
  if (reason.startsWith('revalidation-failed')) return 'GitHub check failed'
  return 'Blocked by dependency'
}

function health(state: AutomationListEntry['state'], now: number): { tone: StatusDotTone; text: string } {
  if (!state?.lastSuccessAt && !state?.consecutiveFailures) return { tone: 'neutral', text: 'Not checked yet' }
  if (state?.backoffUntil && Date.parse(state.backoffUntil) > now) {
    return { tone: 'danger', text: `Backing off after ${state.consecutiveFailures ?? 1} failed check(s)` }
  }
  if (state?.consecutiveFailures) return { tone: 'pending', text: `${state.consecutiveFailures} recent failed check(s)` }
  return { tone: 'success', text: 'Healthy' }
}

/**
 * The "Issue intake" card on an automation's log page: is polling healthy, when did it last
 * succeed and reconcile, and which issues are queued behind a limit or a blocker, and why.
 */
export function IntakeHealthCard({ automation, records, timeZone, now = Date.now() }: {
  automation?: AutomationListEntry
  records: readonly AutomationLogRecord[]
  timeZone: string
  now?: number
}) {
  const state = automation?.state
  const status = health(state, now)
  const summary = summarizeIntake(records)
  const filters = automation?.filters as { fullReconcileHours?: number; maxAdmissionsPerCycle?: number } | undefined
  const stamp = (iso?: string) => (iso ? logTime(iso, timeZone) : '—')
  const recovered = state?.lastReconcileRecovered
  return (
    <Card flush data-slot="intake-health" className="w-full max-w-[820px] px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-[.05em] uppercase text-soft-foreground">Issue intake</span>
        <Pill dot={status.tone} className="w-fit">{status.text}</Pill>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-4">
        <Stat label="Last success" value={stamp(state?.lastSuccessAt)} />
        <Stat label="Next check" value={stamp(automation?.nextRunAt ?? state?.nextCheckAt)} />
        <Stat
          label="Last reconcile"
          value={filters?.fullReconcileHours === undefined ? 'Off' : `${stamp(state?.lastReconcileAt)}${recovered ? ` · recovered ${recovered}` : ''}`}
        />
        <Stat label="Admission limit" value={filters?.maxAdmissionsPerCycle === undefined ? 'Unlimited' : `${filters.maxAdmissionsPerCycle} / cycle`} />
        <Stat label="Launched" value={String(summary.launched)} />
        <Stat label="Waiting" value={String(summary.waiting.length)} />
        <Stat label="Duplicates" value={String(summary.duplicates)} />
        <Stat label="Errors" value={String(summary.errors)} />
      </dl>
      {summary.waiting.length > 0 ? (
        <ul data-slot="intake-waiting" className="mt-3 flex flex-col gap-1 border-t border-border pt-2 text-[12.5px]">
          {summary.waiting.map((item) => (
            <li key={item.receiptId} className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-muted-foreground">{item.githubNumber === undefined ? '—' : `#${item.githubNumber}`}</span>
              <span className="min-w-0 flex-1 truncate" title={item.githubTitle}>{item.githubTitle ?? ''}</span>
              <Pill dot="pending" className="w-fit">{deferralLabel(item.reason)}</Pill>
              <span className="max-w-[320px] truncate text-muted-foreground" title={item.reason}>{item.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-soft-foreground">{label}</dt>
      <dd className="m-0 font-medium">{value}</dd>
    </div>
  )
}
