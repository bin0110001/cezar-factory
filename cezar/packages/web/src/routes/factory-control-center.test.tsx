import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FactoryControlCenterRoute } from './factory-control-center'

const useFactoryControlCenter = vi.fn()
const mutate = vi.fn()
vi.mock('@/api/queries', () => ({ useFactoryControlCenter: () => useFactoryControlCenter(), useCandidateAction: () => ({ mutate, isPending: false, isError: false, data: undefined }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const now = '2026-11-15T12:00:00.000Z'
const snapshot = {
  schemaVersion: 1 as const,
  generatedAt: now,
  projects: [{
    id: 'shop', name: 'Shop', configuredChannel: 'dev' as const,
    compatibility: 'unknown' as const, freshness: 'fresh' as const, readAt: now,
    findings: ['shadow_drift'],
    channels: [
      { channel: 'dev' as const, desiredSha: 'a'.repeat(40), activatedSha: 'a'.repeat(40), observedSha: 'a'.repeat(40), state: 'healthy' as const, updatedAt: now, manifestDigest: null, manifest: null },
      { channel: 'stable' as const, desiredSha: 'b'.repeat(40), activatedSha: null, observedSha: null, state: 'quarantined' as const, updatedAt: now, manifestDigest: null, manifest: null },
    ],
    history: [{ id: 'receipt-1', channel: 'dev', desiredSha: 'a'.repeat(40), actualSha: 'a'.repeat(40), observedSha: 'a'.repeat(40), state: 'active' as const, requestedAt: now, stagedAt: now, activatedAt: now, observedAt: now, compatibility: 'compatible' as const, reasonCode: null, message: null, logRef: null }],
  }],
}

function renderRoute() {
  return render(<MemoryRouter><FactoryControlCenterRoute /></MemoryRouter>)
}

describe('Factory Control Center route', () => {
  it('shows separate desired, activated and observed state, receipt history, and unknown promotion data', () => {
    useFactoryControlCenter.mockReturnValue({ data: snapshot, isPending: false, isError: false, isFetching: false, refetch: vi.fn() })
    renderRoute()
    expect(screen.getByRole('heading', { name: 'Factory Control Center' })).toBeTruthy()
    expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Quarantined').length).toBeGreaterThan(0)
    const dev = within(screen.getByLabelText('Shop dev release'))
    expect(dev.getByText('Desired').parentElement?.textContent).toContain('a'.repeat(12))
    expect(dev.getByText('Activated').parentElement?.textContent).toContain('a'.repeat(12))
    expect(dev.getByText('Observed').parentElement?.textContent).toContain('a'.repeat(12))
    expect(screen.getAllByText('Manifest and local validation evidence: Unknown')).toHaveLength(2)
    expect(screen.getByText('Promotion eligibility and soak checkpoints come from the host scheduler records, which are not exposed by the project activation API. Queue state is unknown here.')).toBeTruthy()
    expect(screen.getByText('Shop · dev · active')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Verification history' }).getAttribute('href')).toBe('/verification')
  })

  it('renders loading, empty and error states without claiming a healthy release', () => {
    useFactoryControlCenter.mockReturnValue({ isPending: true, isError: false, isFetching: true, refetch: vi.fn() })
    const view = renderRoute()
    expect(screen.getByRole('status').textContent).toContain('Loading release records')
    view.unmount()
    useFactoryControlCenter.mockReturnValue({ data: { ...snapshot, projects: [] }, isPending: false, isError: false, isFetching: false, refetch: vi.fn() })
    renderRoute()
    expect(screen.getByText('No registered projects are available in this workspace.')).toBeTruthy()
    cleanup()
    useFactoryControlCenter.mockReturnValue({ isPending: false, isError: true, error: new Error('offline'), isFetching: false, refetch: vi.fn() })
    renderRoute()
    expect(screen.getByRole('alert').textContent).toContain('offline')
  })

  it('requires the typed phrase for destructive actions and only calls the endpoint', () => {
    useFactoryControlCenter.mockReturnValue({ data: snapshot, isPending: false, isError: false, isFetching: false, refetch: vi.fn() })
    renderRoute()
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'cancel' } })
    fireEvent.change(screen.getByLabelText('Candidate id'), { target: { value: 'c-1' } })
    const run = screen.getByRole('button', { name: 'Run cancel' }) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Typed confirmation'), { target: { value: 'cancel c-1' } })
    expect(run.disabled).toBe(false)
    fireEvent.click(run)
    expect(mutate).toHaveBeenCalledWith({ projectId: 'shop', action: 'cancel', candidateId: 'c-1', confirmation: 'cancel c-1' })
  })
})
