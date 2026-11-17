import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Candidate, CandidateActionResponse, PipelinePolicyPreviewResponse, PipelinePolicySaveResponse } from '@open-mercato/cezar-api-client'
import { CandidateActions, offeredActions } from './release-candidate-actions'
import { PipelinePolicyEditor } from './pipeline-policy-editor'

afterEach(() => cleanup())

const cand = (state: Candidate['state'], id = 'cand-1') => ({ id, state }) as Candidate
const queued: CandidateActionResponse = { accepted: true, requestId: 'r1', action: 'pause', projectId: 'tableflux', candidateId: 'cand-1', status: 'queued', message: 'pause requested for cand-1.' }

describe('candidate actions (#634)', () => {
  it('offers only the actions that fit the state', () => {
    expect(offeredActions(null, null)).toEqual(['create'])
    expect(offeredActions(null, 'failed')).toEqual(['create', 'retry'])
    expect(offeredActions(cand('validating'), null)).toEqual(['pause', 'resume', 'cancel', 'abandon'])
    expect(offeredActions(cand('repair-required'), null)).toContain('retry')
    expect(offeredActions(cand('promoted'), null)).toEqual(['create'])
  })

  it('sends a reasoned action for the active candidate and shows that it is queued, not applied', async () => {
    const send = vi.fn(() => Promise.resolve(queued))
    render(<CandidateActions projectId="tableflux" active={cand('validating')} lastState={null} send={send} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const submit = screen.getByRole('button', { name: 'Request pause' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Waiting on a fix' } })
    fireEvent.click(submit)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Queued for the release engine'))
    expect(send).toHaveBeenCalledWith({ action: 'pause', projectId: 'tableflux', candidateId: 'cand-1', reason: 'Waiting on a fix' })
  })

  it('makes a destructive action require the typed candidate id', async () => {
    const send = vi.fn(() => Promise.resolve({ ...queued, action: 'cancel' as const }))
    render(<CandidateActions projectId="tableflux" active={cand('validating')} lastState={null} send={send} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Wrong branch' } })
    const submit = screen.getByRole('button', { name: 'Request cancel' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/type cand-1 to confirm/), { target: { value: 'cand-2' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/type cand-1 to confirm/), { target: { value: 'cand-1' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(send).toHaveBeenCalledWith({ action: 'cancel', projectId: 'tableflux', candidateId: 'cand-1', reason: 'Wrong branch', confirm: 'cand-1' }))
  })

  it('shows a refusal as returned', async () => {
    render(<CandidateActions projectId="tableflux" active={null} lastState={null} send={() => Promise.reject(new Error('Release candidate actions are only available from the local machine.'))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start a candidate' }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Scheduled window' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request start a candidate' }))
    expect((await screen.findByRole('alert')).textContent).toContain('local machine')
  })
})

const H = (c: string) => `sha256:${c.repeat(64)}`
const okPreview: PipelinePolicyPreviewResponse = { valid: true, errors: [], effective: {}, effectiveHash: H('b'), currentHash: H('a'), nextRuns: ['2026-11-18T03:00:00.000Z'] }
const saved: PipelinePolicySaveResponse = { saved: true, projectId: 'tableflux', beforeHash: H('a'), afterHash: H('b'), auditId: 'pol-1', appliesTo: 'future-candidates' }
const initial = { tableflux: { policy: { promotion: { mode: 'auto' } }, effectiveHash: H('a') } }

describe('pipeline policy editor (#632)', () => {
  it('previews errors with paths and cannot save an invalid policy', async () => {
    const save = vi.fn()
    render(<PipelinePolicyEditor projectIds={['tableflux']} initial={initial} preview={() => Promise.resolve({ ...okPreview, valid: false, errors: ['projects.tableflux.promotion.bogus: unknown field'], effective: null, effectiveHash: null })} save={save} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect((await screen.findByTestId('policy-errors')).textContent).toContain('promotion.bogus: unknown field')
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull()
  })

  it('previews, then saves with a reason bound to the hash it loaded, and says it applies to future candidates', async () => {
    const preview = vi.fn(() => Promise.resolve(okPreview))
    const save = vi.fn(() => Promise.resolve(saved))
    render(<PipelinePolicyEditor projectIds={['tableflux']} initial={initial} preview={preview} save={save} />)
    fireEvent.change(screen.getByLabelText(/Override/), { target: { value: '{"promotion":{"mode":"manual"}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect((await screen.findByTestId('policy-preview')).textContent).toContain('2026-11-18 03:00')
    expect(preview).toHaveBeenCalledWith({ projectId: 'tableflux', policy: { promotion: { mode: 'manual' } } })
    const button = screen.getByRole('button', { name: 'Save policy' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Reason for the change/), { target: { value: 'Require approval' } })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('future candidates only'))
    expect(save).toHaveBeenCalledWith({ projectId: 'tableflux', policy: { promotion: { mode: 'manual' } }, reason: 'Require approval', expectedCurrentHash: H('a') })
  })

  it('editing after a preview withdraws the preview, so an unchecked edit cannot be saved', async () => {
    render(<PipelinePolicyEditor projectIds={['tableflux']} initial={initial} preview={() => Promise.resolve(okPreview)} save={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByTestId('policy-preview')
    fireEvent.change(screen.getByLabelText(/Override/), { target: { value: '{}' } })
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull()
  })

  it('rejects text that is not a JSON object without calling the service', async () => {
    const preview = vi.fn()
    render(<PipelinePolicyEditor projectIds={['tableflux']} initial={initial} preview={preview} save={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Override/), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/JSON object/)
    expect(preview).not.toHaveBeenCalled()
  })
})
