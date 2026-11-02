import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router'
import type { AutomationLogRecord } from '@open-mercato/cezar-api-client'

import { deferralLabel, IntakeHealthCard, IntakeOverview, summarizeIntake } from './intake-health'

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

describe('IntakeOverview', () => {
  const entry = (id: string, state: object, enabled = true, kind = 'github') =>
    ({ id, name: id, kind, enabled, filters: { fullReconcileHours: 24 }, state }) as never

  it('lists only enabled GitHub pollers with health and reconcile recovery', () => {
    const { container } = render(
      <MemoryRouter><IntakeOverview
        timeZone="UTC"
        now={Date.parse('2026-11-02T10:00:00.000Z')}
        automations={[
          entry('ok', { lastSuccessAt: '2026-11-02T09:55:00.000Z', lastReconcileAt: '2026-11-02T06:00:00.000Z', lastReconcileRecovered: 2 }),
          entry('backed-off', { consecutiveFailures: 2, backoffUntil: '2026-11-02T11:00:00.000Z' }),
          entry('paused', {}, false),
          entry('nightly', {}, true, 'schedule'),
        ]}
      /></MemoryRouter>,
    )
    expect(container.querySelectorAll('[data-slot="intake-overview-row"]')).toHaveLength(2)
    expect(screen.getByText('Healthy')).not.toBeNull()
    expect(screen.getByText(/Backing off after 2/)).not.toBeNull()
    expect(container.textContent).toContain('(+2)')
  })

  it('renders nothing without an enabled GitHub poller', () => {
    const { container } = render(<IntakeOverview timeZone="UTC" automations={[entry('paused', {}, false)]} />)
    expect(container.firstChild).toBeNull()
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

  it('runs a dry-run preview and reports what would launch', async () => {
    const onPreview = async () => ({ id: 'c', automationId: 'a', mode: 'preview' as const, status: 'complete' as const, createdAt: '2026-11-02T10:00:00.000Z', matches: 2 })
    const { container } = render(<IntakeHealthCard automation={automation} records={[]} timeZone="UTC" onPreview={onPreview} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview check' }))
    await waitFor(() => expect(container.querySelector('[data-slot="intake-preview"]')?.textContent).toContain('2 issue(s) would launch'))
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
