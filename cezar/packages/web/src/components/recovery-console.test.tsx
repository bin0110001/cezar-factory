import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecoveryConsole } from './recovery-console'
import {
  aggregateIncidents, createFixtureRecoveryClient,
  type RecoveryClient, type RecoveryIncident, type RecoveryState,
} from '@/lib/recovery-contract'

afterEach(cleanup)

const fp = 'a'.repeat(64)
const incident = (over: Partial<RecoveryIncident> = {}): RecoveryIncident => ({
  failureClass: 'release', fingerprint: fp, summary: 'canary failed', status: 'open', attemptCount: 1, nextAttemptAt: 1_800_000_000,
  escalated: false, firstSeen: 1, lastSeen: 2, candidateSha: 'abc123', causalEvidence: { log: 'boom' }, affectedProjects: ['proj-a'],
  priorRepairs: [{ id: 'r1', outcome: 'failed' }], generatedPrUrl: 'https://github.com/o/r/pull/9', ...over,
})
const state = (over: Partial<RecoveryState> = {}): RecoveryState => ({
  incidents: [incident()], conflict: null,
  grantedScopes: ['recovery:retry', 'recovery:reconcile', 'recovery:quarantine', 'recovery:rollback'], ...over,
})
const open = async (client: RecoveryClient) => {
  render(<RecoveryConsole client={client} pollMs={1} />)
  fireEvent.click(await screen.findByRole('button', { name: /canary failed/ }))
}

describe('aggregation', () => {
  it('merges same-fingerprint incidents into one entry with count and escalated severity', () => {
    const out = aggregateIncidents([incident(), incident({ lastSeen: 5, attemptCount: 3, affectedProjects: ['proj-b'] }), incident({ lastSeen: 6 })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ occurrenceCount: 3, severity: 'warning', attemptCount: 3, affectedProjects: ['proj-a', 'proj-b'] })
    expect(aggregateIncidents([incident({ escalated: true })])[0]?.severity).toBe('critical')
  })
})

describe('RecoveryConsole', () => {
  it('lists incidents and shows drill-down details', async () => {
    await open(createFixtureRecoveryClient(state()))
    expect(screen.getByText(/attempts 1/)).toBeTruthy()
    const details = screen.getByRole('article', { name: 'Incident details' })
    expect(details.textContent).toContain('proj-a')
    expect(details.textContent).toContain('log: boom')
    expect(details.textContent).toContain('r1 (failed)')
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://github.com/o/r/pull/9')
  })

  it('disables actions with an explanation when scope is missing', async () => {
    await open(createFixtureRecoveryClient(state({ grantedScopes: ['recovery:retry'] })))
    expect((screen.getByRole('button', { name: 'rollback' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Requires the recovery:rollback permission/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'retry' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables all actions during a backend-reported conflict', async () => {
    await open(createFixtureRecoveryClient(state({ conflict: { kind: 'activation', detail: 'an activation is in progress.' } })))
    for (const name of ['retry', 'reconcile', 'quarantine', 'rollback']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('recovery-conflict')).toBeTruthy()
  })

  it('requires confirmation for high-risk actions and sends an idempotency key', async () => {
    const client = createFixtureRecoveryClient(state())
    const submit = vi.spyOn(client, 'submitAction')
    await open(client)
    fireEvent.click(screen.getByRole('button', { name: 'rollback' }))
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rollback/ }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit.mock.calls[0]![0]).toMatchObject({ action: 'rollback', fingerprint: fp })
    expect(submit.mock.calls[0]![0].idempotencyKey.length).toBeGreaterThan(8)
    expect(await screen.findByText(/rollback succeeded \(audit audit-1\)/)).toBeTruthy()
  })

  it('runs low-risk actions without confirmation and reports success only from the receipt', async () => {
    const base = createFixtureRecoveryClient(state())
    let polls = 0
    const client: RecoveryClient = {
      ...base,
      submitAction: async (r) => ({ idempotencyKey: r.idempotencyKey, state: 'pending' }),
      getReceipt: async (k) => (++polls < 2 ? { idempotencyKey: k, state: 'pending' } : { idempotencyKey: k, state: 'succeeded', auditId: 'a9' }),
    }
    await open(client)
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(await screen.findByText(/waiting for the backend receipt/)).toBeTruthy()
    expect(screen.queryByText(/retry succeeded/)).toBeNull()
    expect(await screen.findByText(/retry succeeded \(audit a9\)/)).toBeTruthy()
  })

  it('shows an accessible alert on a failed receipt and on a rejected call', async () => {
    const base = createFixtureRecoveryClient(state())
    await open({ ...base, submitAction: async (r) => ({ idempotencyKey: r.idempotencyKey, state: 'failed', message: 'denied by policy' }) })
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('denied by policy')
    expect(alert.getAttribute('aria-live')).toBe('assertive')
    await waitFor(() => expect(document.activeElement).toBe(alert))
    cleanup()
    await open({ ...base, submitAction: async () => { throw new Error('network down') } })
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect((await screen.findByRole('alert')).textContent).toContain('network down')
  })

  it('shows an error when loading fails', async () => {
    render(<RecoveryConsole client={{ ...createFixtureRecoveryClient(state()), load: async () => { throw new Error('boom') } }} />)
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
  })
})
