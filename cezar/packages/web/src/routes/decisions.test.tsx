import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionItem, DecisionsResponse } from '@open-mercato/cezar-contract'

import { createQueryClient } from '@/api/query-client'

const getDecisions = vi.fn()
const answerDecision = vi.fn()
const getDependencyGraph = vi.fn()
const getDependencyStalls = vi.fn()
const transitionDependencyDecision = vi.fn()
vi.mock('@/api/client', () => ({
  getDecisions: (...a: unknown[]) => getDecisions(...a),
  answerDecision: (...a: unknown[]) => answerDecision(...a),
  getDependencyGraph: (...a: unknown[]) => getDependencyGraph(...a),
  getDependencyStalls: (...a: unknown[]) => getDependencyStalls(...a),
  transitionDependencyDecision: (...a: unknown[]) => transitionDependencyDecision(...a),
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
  decisions: [{
    id: 'open-question', question: 'Which data source is authoritative?',
    context: 'Two sources are mentioned in the issue. State the specific path you choose and why.', options: [],
  }],
}

function renderRoute(response?: DecisionsResponse, graph?: unknown, stalls?: unknown) {
  if (response) getDecisions.mockResolvedValue(response)
  getDependencyGraph.mockResolvedValue(graph ?? { schemaVersion: 1, repository: 'github.com/o/r', revision: 8, createdAt: '2026-11-03T00:00:00Z', source: { status: 'fresh' }, nodes: [], edges: [], decisions: [], page: { limit: 500, offset: 0, totalNodes: 0, hasMore: false } })
  getDependencyStalls.mockResolvedValue(stalls ?? { revision: 8, verdict: 'healthy', summary: 'Nothing is stalled.', counts: { running: 0, runnable: 0, blocked: 0, waiting: 0, stuck: 0 }, items: [], cycles: [] })
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
    expect(isAnswerable([{ id: 'legacy', question: 'Choose?', context: 'No options supplied.', options: [] }], { legacy: { optionId: 'recommended-next-step', note: '' } })).toBe(false)
    expect(isAnswerable([{ id: 'legacy', question: 'Choose?', context: 'No options supplied.', options: [] }], { legacy: { note: 'Choose TypeScript because it shares dispatch ownership.' } })).toBe(true)
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
  it('keeps progressing dependencies out of operator help and identifies stale blocks as recovery', async () => {
    const graph = {
      schemaVersion: 1, repository: 'github.com/o/r', revision: 8, createdAt: '2026-11-03T00:00:00Z', source: { status: 'fresh' },
      nodes: [
        { id: 'issue:o/r:7', kind: 'issue', number: 7, title: 'Blocked by active work', state: 'open', labels: ['factory:blocked'], url: 'https://github.com/o/r/issues/7' },
        { id: 'issue:o/r:8', kind: 'issue', number: 8, title: 'Missing consumer', state: 'open', labels: ['factory:blocked'], url: 'https://github.com/o/r/issues/8', bodyText: 'The automation is disabled.' },
      ], edges: [], decisions: [], page: { limit: 500, offset: 0, totalNodes: 2, hasMore: false },
    }
    const stalls = {
      revision: 8, verdict: 'stalled', summary: 'One stuck issue.', counts: { running: 0, runnable: 0, blocked: 1, waiting: 0, stuck: 1 }, cycles: [],
      items: [
        { nodeId: 'issue:o/r:7', number: 7, title: 'Blocked by active work', labels: ['factory:blocked'], class: 'blocked', rootCauseIds: [], blockerIds: ['issue:o/r:6'], detail: 'Waiting on work that is progressing.' },
        { nodeId: 'issue:o/r:8', number: 8, title: 'Missing consumer', labels: ['factory:blocked'], bodyText: 'The automation is disabled.', class: 'stuck', reason: 'no-consumer', rootCauseIds: ['issue:o/r:8'], blockerIds: [], detail: 'No enabled automation consumes factory:blocked.' },
      ],
    }
    renderRoute({ available: true, items: [] }, graph, stalls)
    await waitFor(() => expect(document.querySelector('[data-slot="operator-help-card"]')).not.toBeNull())
    const card = document.querySelector('[data-slot="operator-help-card"]')!
    expect(card.textContent).toContain('Missing consumer')
    expect(card.textContent).toContain('Factory recovery needed')
    expect(card.textContent).toContain('automation is disabled')
    expect(screen.queryByText('Blocked by active work')).toBeNull()
  })

  it('records human approvals with the graph revision and a reason', async () => {
    const graph = {
      schemaVersion: 1, repository: 'github.com/o/r', revision: 11, createdAt: '2026-11-03T00:00:00Z', source: { status: 'fresh' }, nodes: [], edges: [],
      decisions: [{ id: 'decision:o/r:release-gate', question: 'Approve the release gate?', options: ['Approve', 'Reject'], rationale: 'The validated candidate is ready.', state: 'proposed', revision: 2, requiredAuthorization: 'human-approval', createdBy: 'agent', evidence: [], reversible: false, affectedNodeIds: [] }],
      page: { limit: 500, offset: 0, totalNodes: 1, hasMore: false },
    }
    transitionDependencyDecision.mockResolvedValue({ revision: 12, decision: { id: 'decision:o/r:release-gate', question: 'Approve the release gate?', state: 'approved', revision: 3 } })
    renderRoute({ available: true, items: [] }, graph)
    await screen.findByText('Approve the release gate?')
    fireEvent.change(screen.getByLabelText('Record your reason (required)'), { target: { value: 'Validated release evidence reviewed.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(transitionDependencyDecision).toHaveBeenCalledWith({
      expectedGraphRevision: 11, decisionId: 'decision:o/r:release-gate', to: 'approved', resolution: 'Validated release evidence reviewed.',
    }))
  })

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

  it('explains that a legacy ask needs a specific written decision', async () => {
    const withFix: DecisionItem = {
      ...legacy,
      background: [
        { label: 'Latest planning analysis', text: 'The alternatives are: 1. Port admission into TypeScript. 2. Keep Python and define durable leases.' },
        { label: 'Investigator’s root cause', text: 'The fixture is stale.' },
        { label: 'Current hypothesis', text: 'Scope is too broad.' },
      ],
      decisions: [{ id: 'open-question', question: 'Which data source is authoritative?', context: 'State the path and why.', options: [] }],
    }
    renderRoute({ available: true, items: [withFix] })
    const card = await screen.findByRole('listitem')
    const blocks = [...card.querySelectorAll('[data-slot="decision-background-block"]')]
    expect(blocks.map((b) => b.textContent)).toEqual([
      'Latest planning analysisThe alternatives are: 1. Port admission into TypeScript. 2. Keep Python and define durable leases.',
      'Investigator’s root causeThe fixture is stale.',
      'Current hypothesisScope is too broad.',
    ])
    expect(within(card).getByText(/Port admission into TypeScript/)).toBeTruthy()
    expect(within(card).getByText(/no reliable answer choices/i)).toBeTruthy()
    expect(within(card).getByLabelText(/Your decision \(required\)/)).toBeTruthy()
    expect(card.querySelectorAll('[data-slot="decision-option"]')).toHaveLength(0)
  })

  it('shows no background section when the Factory had nothing to add', async () => {
    renderRoute({ available: true, items: [structured] })
    const card = await screen.findByRole('listitem')
    expect(card.querySelector('[data-slot="decision-background"]')).toBeNull()
  })

  it('renders decision context as formatted Markdown', async () => {
    const formatted: DecisionItem = {
      ...structured,
      decisions: [{ ...structured.decisions[0]!, context: '## Evidence\n\n- **Blocked:** no merged PR\n- Candidate `7c5fe25`.' }],
    }
    renderRoute({ available: true, items: [formatted] })
    const context = await screen.findByLabelText('Context for: Where should run state live?')
    expect(within(context).getByRole('heading', { name: 'Evidence' })).toBeTruthy()
    expect(within(context).getAllByRole('listitem')[0]?.textContent).toContain('Blocked: no merged PR')
    expect(within(context).getByText('7c5fe25').tagName).toBe('CODE')
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

  it('answers a legacy escalation in the users own words', async () => {
    answerDecision.mockResolvedValue({ number: 9, state: 'factory:needs-plan' })
    renderRoute({ available: true, items: [legacy] })
    const send = await screen.findByRole('button', { name: /send answer/i })
    expect(document.querySelectorAll('[data-slot="decision-option"]')).toHaveLength(0)
    expect((send as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Your decision \(required\)/), { target: { value: 'Use billing as the authoritative source because it owns account state.' } })
    fireEvent.click(send)
    await waitFor(() => expect(answerDecision).toHaveBeenCalledWith(9, { answers: [{ decisionId: 'open-question', note: 'Use billing as the authoritative source because it owns account state.' }] }))
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
    expect(await screen.findByText('Nothing needs your attention')).toBeTruthy()
  })

  it('explains an unreachable GitHub instead of claiming there are no decisions', async () => {
    renderRoute({ available: false, reason: 'gh: not logged in', items: [] })
    expect(await screen.findByText(/GitHub decision issues are unavailable/)).toBeTruthy()
    expect(screen.queryByText('Nothing needs your attention')).toBeNull()
  })
})
