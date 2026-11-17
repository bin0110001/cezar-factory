import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QualityDryRunResponse, WaiverResponse } from '@open-mercato/cezar-api-client'
import { QualityActionsSection } from './release-quality-actions'

afterEach(() => cleanup())

const result: QualityDryRunResponse = {
  valid: true, errors: [], candidateId: 'c1',
  stages: [{ stage: 'stable', wouldBlock: true, checks: [
    { category: 'sca', status: 'error', level: 'required', onUnavailable: 'fail-closed', blocks: true, note: 'scan failed; fails closed' },
    { category: 'sast', status: 'fail', level: 'required', onUnavailable: 'fail-closed', blocks: true, note: 'confirmed finding' },
  ] }],
  estimate: { computeHours: null, basis: 'no cost recorded' }, warnings: ['Trivy database is stale'],
}
const waiver: WaiverResponse = { accepted: true, requestId: 'w1', projectId: 'tableflux', expiresAt: '2026-11-24T00:00:00.000Z', maxDays: 30, status: 'queued', message: 'Queued.' }
const show = (over: { dryRun?: () => Promise<QualityDryRunResponse>; requestWaiver?: () => Promise<WaiverResponse> } = {}, ids = ['tableflux']) => {
  const dryRun = vi.fn(over.dryRun ?? (() => Promise.resolve(result)))
  const requestWaiver = vi.fn(over.requestWaiver ?? (() => Promise.resolve(waiver)))
  render(<QualityActionsSection projectIds={ids} dryRun={dryRun} requestWaiver={requestWaiver} />)
  return { dryRun, requestWaiver }
}

describe('quality actions', () => {
  it('shows a failed scan apart from a confirmed finding, and the stale feed warning', async () => {
    const { dryRun } = show()
    fireEvent.change(screen.getByLabelText(/Policy \(quality-gates/), { target: { value: '{"schemaVersion":"quality-gates/v1"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run dry run' }))
    await waitFor(() => expect(screen.getByTestId('dry-run-result')).toBeTruthy())
    expect(dryRun).toHaveBeenCalledWith({ projectId: 'tableflux', policy: { schemaVersion: 'quality-gates/v1' } })
    const stage = screen.getByTestId('dry-stage-stable').textContent ?? ''
    expect(stage).toContain('would block')
    expect(stage).toContain('sca · error')
    expect(stage).toContain('sast · fail')
    expect(screen.getByText('Trivy database is stale')).toBeTruthy()
  })

  it('rejects policy text that is not a JSON object without calling the service', async () => {
    const { dryRun } = show()
    fireEvent.change(screen.getByLabelText(/Policy \(quality-gates/), { target: { value: '[1]' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run dry run' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/JSON object/)
    expect(dryRun).not.toHaveBeenCalled()
  })

  it('lists validation errors from an invalid policy', async () => {
    show({ dryRun: () => Promise.resolve({ ...result, valid: false, errors: ['defaults.checks.sca.stable: must fail closed'] }) })
    fireEvent.change(screen.getByLabelText(/Policy \(quality-gates/), { target: { value: '{}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run dry run' }))
    expect((await screen.findByTestId('dry-run-errors')).textContent).toContain('must fail closed')
  })

  it('only enables a waiver request that names what it covers, a stage, a reason and an expiry, and sends an advisory id or fingerprint', async () => {
    const { requestWaiver } = show()
    const button = screen.getByRole('button', { name: 'Request waiver' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Finding fingerprint/), { target: { value: 'CVE-2026-1234' } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'short' } })
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Upstream fix lands next week' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Queued for the release engine until 2026-11-24'))
    expect(requestWaiver).toHaveBeenCalledWith({ projectId: 'tableflux', stages: ['stable'], reason: 'Upstream fix lands next week', expiresInDays: 7, advisoryId: 'CVE-2026-1234' })
  })

  it('shows a refusal from the service (remote cockpit, unknown project) as returned', async () => {
    show({ requestWaiver: () => Promise.reject(new Error('Waivers can only be requested from the local machine.')) })
    fireEvent.change(screen.getByLabelText(/Finding fingerprint/), { target: { value: 'a'.repeat(64) } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Upstream fix lands next week' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request waiver' }))
    expect((await screen.findByRole('alert')).textContent).toContain('local machine')
  })

  it('says so when no project has published a snapshot', () => {
    show({}, [])
    expect(screen.getByText(/No project has published/)).toBeTruthy()
  })
})
