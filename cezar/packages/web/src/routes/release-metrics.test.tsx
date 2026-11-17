import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReleaseHistoryResponse, ReleaseMetricsResponse } from '@open-mercato/cezar-api-client'
import { ReleaseMetricsSection } from './release-metrics'

afterEach(() => cleanup())

const NOW = '2026-11-16T12:00:00.000Z'
const metrics = (over: Partial<ReleaseMetricsResponse['projects'][number]> = {}): ReleaseMetricsResponse => ({
  schemaVersion: 1, generatedAt: NOW, available: true,
  projects: [{
    projectId: 'tableflux', queueWaitMinutes: { mean: 60, max: 90, samples: 2 }, suiteCostHours: { total: 3, mean: 1.5, samples: 2 }, regressions: { candidatesWithRepair: 1, candidates: 2 },
    forwardPortLagHours: { oldest: 24, unresolved: 1 }, stableAgeHours: 150, scheduledChecks: { runs: 2, failing: 1, lastRanAt: '2026-11-16T03:00:00.000Z' },
    aiAudit: { ran: 1, skipped: 1, costUsd: 1.25, tokens: 9000 }, ...over,
  }],
})
const history = (entries: ReleaseHistoryResponse['entries'] = []): ReleaseHistoryResponse => ({ schemaVersion: 1, generatedAt: NOW, retentionDays: { tableflux: 90 }, entries, candidates: [] })
const h = (n: number) => `sha256:${String(n).repeat(64)}`
const show = (m?: ReleaseMetricsResponse, hist?: ReleaseHistoryResponse, extra: { m?: object; h?: object } = {}) =>
  render(<ReleaseMetricsSection metrics={{ data: m, ...extra.m }} history={{ data: hist, ...extra.h }} />)

describe('release metrics and history view', () => {
  it('shows every metric computed from the read model, including independent checks and AI audit cost', () => {
    show(metrics(), history())
    const card = within(screen.getByTestId('metrics-tableflux'))
    expect(card.getByText('Queue wait (mean / worst)').nextElementSibling?.textContent).toBe('60 min / 90 min')
    expect(card.getByText('Suite cost (total / mean)').nextElementSibling?.textContent).toBe('3 h / 1.5 h')
    expect(card.getByText(/1 of 2 candidates needed repair/)).toBeTruthy()
    expect(card.getByText(/24 h oldest · 1 unresolved/)).toBeTruthy()
    expect(card.getByText(/150 h since last promotion/)).toBeTruthy()
    expect(card.getByText(/2 runs · 1 failing/)).toBeTruthy()
    expect(card.getByText(/1 ran · 1 skipped · \$1\.25 · 9000 tokens/)).toBeTruthy()
  })

  it('shows "not recorded" for missing inputs, never zero or an estimate', () => {
    show(metrics({ queueWaitMinutes: { mean: null, max: null, samples: 0 }, suiteCostHours: { total: null, mean: null, samples: 0 }, forwardPortLagHours: { oldest: null, unresolved: 0 }, stableAgeHours: null }), history())
    const card = within(screen.getByTestId('metrics-tableflux'))
    expect(card.getByText('Queue wait (mean / worst)').nextElementSibling?.textContent).toBe('not recorded / not recorded')
    expect(card.getByText(/not recorded oldest · 0 unresolved/)).toBeTruthy()
    expect(card.getByText('Stable age').nextElementSibling?.textContent).toBe('not recorded')
  })

  it('lists audit history with policy hashes and retention, distinguishing policy changes from operator actions', () => {
    show(metrics(), history([
      { id: 'pol-1', at: '2026-11-16T10:00:00.000Z', kind: 'policy-change', projectId: 'tableflux', actor: 'local-operator', summary: 'policy changed: weekly', candidateId: null, beforeHash: h(1), afterHash: h(2) },
      { id: 'act-1', at: '2026-11-16T09:00:00.000Z', kind: 'operator-action', projectId: 'tableflux', actor: 'local-operator', summary: 'cancel c1: stuck', candidateId: 'c1', beforeHash: null, afterHash: null },
    ]))
    const audit = within(screen.getByLabelText('Audit history'))
    expect(audit.getByText(/tableflux 90 days/)).toBeTruthy()
    expect(audit.getByTestId('history-pol-1').getAttribute('data-kind')).toBe('policy-change')
    expect(audit.getByTestId('history-pol-1').textContent).toContain('11111111 → 22222222')
    expect(audit.getByTestId('history-act-1').getAttribute('data-kind')).toBe('operator-action')
    expect(audit.getByTestId('history-act-1').textContent).toContain('cancel c1: stuck')
  })

  it('renders empty, unavailable, loading and error states honestly', () => {
    const empty = show(metrics(), history([]))
    expect(screen.getByText(/No operator actions or policy changes within retention/)).toBeTruthy()
    empty.unmount()
    const none = show({ schemaVersion: 1, generatedAt: NOW, available: false, projects: [] }, history())
    expect(screen.getByText(/no metrics yet/)).toBeTruthy()
    none.unmount()
    const loading = show(undefined, undefined, { m: { isPending: true }, h: { isPending: true } })
    expect(screen.getByRole('status').textContent).toContain('Loading')
    loading.unmount()
    show(undefined, undefined, { m: { isError: true } })
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded')
  })
})
