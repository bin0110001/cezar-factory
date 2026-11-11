import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionItem, DecisionsResponse } from '@open-mercato/cezar-contract'

import { createQueryClient } from '@/api/query-client'

const getDecisions = vi.fn()
const answerDecision = vi.fn()
vi.mock('@/api/client', () => ({
  getDecisions: (...a: unknown[]) => getDecisions(...a),
  answerDecision: (...a: unknown[]) => answerDecision(...a),
}))
const toast = vi.fn()
vi.mock('@/components/ui/toaster', () => ({ toast: (...a: unknown[]) => toast(...a) }))

import { DecisionsRoute, buildAnswerBody, isAnswerable } from './decisions'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const structured: DecisionItem = {
  number: 7,
  title: 'Pick storage',
  url: 'https://github.com/o/r/issues/7',
  state: 'factory:needs-help',
  labels: ['factory:needs-help'],
  updatedAt: '2026-11-02T00:00:00Z',
  askedAt: '2026-11-01T10:00:00Z',
  source: 'structured',
  details: '## Factory decision needed\n\nFull text',
  decisions: [{
    id: 'state-owner',
    question: 'Where should run state live?',
    context: 'Two stores exist.',
    recommendedOptionId: 'registry',
    options: [
      { id: 'registry', label: 'Shared registry', summary: 'One owner', tradeoffs: 'Needs a migration' },
      { id: 'local', label: 'Per-project file' },
    ],
  }],
}
const legacy: DecisionItem = {
  ...structured,
  number: 9,
  title: 'Old escalation',
  source: 'legacy',
  decisions: [{ id: 'open-question', question: 'Which data source is authoritative?', options: [] }],
}

function renderRoute(response?: DecisionsResponse) {
  if (response) getDecisions.mockResolvedValue(response)
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter><DecisionsRoute /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('answer helpers', () => {
  const decisions = structured.decisions
  it('needs a path or a written answer for every question', () => {
    expect(isAnswerable(decisions, {})).toBe(false)
    expect(isAnswerable(decisions, { 'state-owner': { note: '   ' } })).toBe(false)
    expect(isAnswerable(decisions, { 'state-owner': { optionId: 'local', note: '' } })).toBe(true)
    expect(isAnswerable(decisions, { 'state-owner': { note: 'Something else' } })).toBe(true)
  })

  it('builds the request body without empty fields', () => {
    expect(buildAnswerBody(decisions, { 'state-owner': { optionId: 'local', note: ' ' } }, ' ')).toEqual({ answers: [{ decisionId: 'state-owner', optionId: 'local' }] })
    expect(buildAnswerBody(decisions, { 'state-owner': { note: 'Own words' } }, 'Keep it small')).toEqual({
      answers: [{ decisionId: 'state-owner', note: 'Own words' }],
      note: 'Keep it small',
    })
  })
})

describe('DecisionsRoute', () => {
  it('shows the question, details, and every suggested path with the recommendation marked', async () => {
    renderRoute({ available: true, items: [structured] })
    const card = await screen.findByRole('listitem')
    expect(within(card).getByText('Where should run state live?')).toBeTruthy()
    expect(within(card).getByText('Two stores exist.')).toBeTruthy()
    const options = card.querySelectorAll('[data-slot="decision-option"]')
    expect([...options].map((o) => o.getAttribute('data-option'))).toEqual(['registry', 'local'])
    expect(options[0]?.textContent).toContain('Recommended')
    expect(options[0]?.textContent).toContain('Needs a migration')
    expect(options[1]?.textContent).not.toContain('Recommended')
    expect(within(card).getByText('Full Factory comment')).toBeTruthy()
  })

  it('keeps Send disabled until a path is chosen, then posts the answer and removes the card', async () => {
    answerDecision.mockResolvedValue({ number: 7, state: 'factory:needs-plan' })
    // After the answer the server no longer lists the issue, so the reconciling refetch is empty.
    getDecisions.mockResolvedValueOnce({ available: true, items: [structured] }).mockResolvedValue({ available: true, items: [] })
    renderRoute()
    const send = await screen.findByRole('button', { name: /send answer/i })
    expect((send as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByLabelText(/Per-project file/))
    fireEvent.change(screen.getByLabelText('Additional instructions for #7'), { target: { value: 'Keep it small' } })
    expect((send as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(send)

    await waitFor(() => expect(answerDecision).toHaveBeenCalledWith(7, {
      answers: [{ decisionId: 'state-owner', optionId: 'local' }],
      note: 'Keep it small',
    }))
    await waitFor(() => expect(screen.queryByRole('listitem')).toBeNull())
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('#7'))
  })

  it('answers a legacy free-text escalation in the users own words', async () => {
    answerDecision.mockResolvedValue({ number: 9, state: 'factory:needs-plan' })
    renderRoute({ available: true, items: [legacy] })
    const send = await screen.findByRole('button', { name: /send answer/i })
    expect(document.querySelector('[data-slot="decision-option"]')).toBeNull()
    expect((send as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Your answer/), { target: { value: 'Use billing' } })
    fireEvent.click(send)
    await waitFor(() => expect(answerDecision).toHaveBeenCalledWith(9, { answers: [{ decisionId: 'open-question', note: 'Use billing' }] }))
  })

  it('keeps the card and says why when the server refuses', async () => {
    answerDecision.mockRejectedValue(new Error('Issue #7 is no longer waiting for a decision'))
    renderRoute({ available: true, items: [structured] })
    fireEvent.click(await screen.findByLabelText(/Shared registry/))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Issue #7 is no longer waiting for a decision', { tone: 'danger' }))
  })

  it('says so when nothing is waiting', async () => {
    renderRoute({ available: true, items: [] })
    expect(await screen.findByText('Nothing is waiting on you')).toBeTruthy()
  })

  it('explains an unreachable GitHub instead of claiming there are no decisions', async () => {
    renderRoute({ available: false, reason: 'gh: not logged in', items: [] })
    expect(await screen.findByText('GitHub is not reachable')).toBeTruthy()
    expect(screen.queryByText('Nothing is waiting on you')).toBeNull()
  })
})
