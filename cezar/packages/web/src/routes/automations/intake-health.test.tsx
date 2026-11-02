import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationLogRecord } from '@open-mercato/cezar-api-client'

import { deferralLabel, IntakeHealthCard, summarizeIntake } from './intake-health'

afterEach(cleanup)

const row = (seq: number, result: AutomationLogRecord['result'], extra: Partial<AutomationLogRecord> = {}): AutomationLogRecord =>
  ({ seq, ts: '2026-11-02T10:00:00.000Z', automationId: 'a', revision: 1, result, ...extra })

describe('summarizeIntake', () => {
  it('lists a receipt as waiting only while its newest row is deferred', () => {
    // newest first, as the server returns it
    const summary = summarizeIntake([
      row(4, 'launched', { receiptId: 'r1', githubNumber: 1 }),
      row(3, 'deferred', { receiptId: 'r2', githubNumber: 2, githubTitle: 'Two', reason: 'admission-cap: 1 per cycle' }),
      row(2, 'deferred', { receiptId: 'r1', githubNumber: 1, reason: 'blocked by issue 9' }),
      row(1, 'duplicate', { receiptId: 'r3' }),
    ])
    expect(summary.waiting.map((item) => item.receiptId)).toEqual(['r2'])
    expect(summary).toMatchObject({ launched: 1, duplicates: 1, errors: 0 })
  })

  it('maps deferral reasons to operator labels', () => {
    expect(deferralLabel('admission-cap: x')).toBe('Admission limit')
    expect(deferralLabel('no-longer-eligible: closed')).toBe('No longer eligible')
    expect(deferralLabel('revalidation-failed: boom')).toBe('GitHub check failed')
    expect(deferralLabel('blocked by issue 9')).toBe('Blocked by dependency')
  })
})

describe('IntakeHealthCard', () => {
  const automation = {
    id: 'a', name: 'Intake', kind: 'github', filters: { fullReconcileHours: 24, maxAdmissionsPerCycle: 3 },
    state: { lastSuccessAt: '2026-11-02T09:55:00.000Z', lastReconcileAt: '2026-11-02T06:00:00.000Z', lastReconcileRecovered: 2 },
  } as never

  it('shows health, reconciliation, limits and the waiting issues with reasons', () => {
    const { container } = render(
      <IntakeHealthCard
        automation={automation}
        records={[row(1, 'deferred', { receiptId: 'r2', githubNumber: 2, githubTitle: 'Two', reason: 'admission-cap: 3 per cycle' })]}
        timeZone="UTC"
        now={Date.parse('2026-11-02T10:00:00.000Z')}
      />,
    )
    expect(screen.getByText('Healthy')).not.toBeNull()
    expect(screen.getByText(/recovered 2/)).not.toBeNull()
    expect(screen.getByText('3 / cycle')).not.toBeNull()
    expect(container.querySelector('[data-slot="intake-waiting"]')?.textContent).toContain('Admission limit')
    expect(container.querySelectorAll('[data-slot="intake-waiting"] li')).toHaveLength(1)
  })

  it('reports backoff when the poller is backed off', () => {
    render(
      <IntakeHealthCard
        automation={{ ...(automation as object), state: { consecutiveFailures: 3, backoffUntil: '2026-11-02T11:00:00.000Z' } } as never}
        records={[]}
        timeZone="UTC"
        now={Date.parse('2026-11-02T10:00:00.000Z')}
      />,
    )
    expect(screen.getByText(/Backing off after 3/)).not.toBeNull()
  })
})
