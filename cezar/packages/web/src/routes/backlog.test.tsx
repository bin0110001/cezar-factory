import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

const getBacklog = vi.fn()
const getBacklogRecommendation = vi.fn()
const getAutomations = vi.fn()
const editBacklogIssue = vi.fn()
vi.mock('@/api/client', () => ({
  getBacklog: (...a: unknown[]) => getBacklog(...a),
  getBacklogRecommendation: (...a: unknown[]) => getBacklogRecommendation(...a),
  getAutomations: (...a: unknown[]) => getAutomations(...a),
  editBacklogIssue: (...a: unknown[]) => editBacklogIssue(...a),
}))

import { BacklogRoute } from './backlog'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const card = (id: string, lane: string, status: { kind: string; reasonCode: string; detail: string }, badges: string[] = []) => ({
  id, lane, basePriority: 'P1', rank: null, score: 812, status, topFactors: [{ name: 'base-priority', points: 800 }], badges, conflictsWith: [],
})
const LANES = ['Inbox', 'Backlog', 'Refinement', 'Ready', 'Active', 'Review', 'Done']
const data = {
  lanes: LANES.map((lane) => ({
    lane,
    cards: lane === 'Refinement' ? [card('o/r#1', lane, { kind: 'not-dispatchable', reasonCode: 'gated', detail: 'lane is Refinement, not Ready' })]
      : lane === 'Ready' ? [card('o/r#2', lane, { kind: 'deferred', reasonCode: 'conflict-file', detail: 'file overlap with o/r#9' }, ['conflict'])] : [],
  })),
  edges: [{ from: 'o/r#2', to: 'o/r#9', level: 'file', source: 'decision' }],
  mergeDebt: { open: 1, needsAgent: 1, items: [{ key: 'k', state: 'needs-agent', issues: ['o/r#4', 'o/r#5'], githubIssue: 77 }] },
  overrideAudit: [{ id: 'o/r#2', at: '2026-11-03T10:00:00Z', actor: 'alice', reason: 'urgent', changed: ['basePriority'] }],
  views: { blocked: [], deferred: ['o/r#2'] },
  revisions: { 'o/r#1': 3, 'o/r#2': 5 },
  conflicts: 0,
}

function renderRoute() {
  return render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><BacklogRoute /></MemoryRouter></QueryClientProvider>)
}

describe('BacklogRoute', () => {
  it('shows lanes with scheduler reasons, conflicts, merge debt and the override audit', async () => {
    getBacklog.mockResolvedValue(data)
    getBacklogRecommendation.mockResolvedValue({ next: { id: 'o/r#3', score: 700, factors: [{ name: 'base-priority', points: 600 }] }, top: [], needsHuman: [{ id: 'o/r#8', reason: 'unset' }] })
    getAutomations.mockResolvedValue({ automations: [{ kind: 'github', enabled: true, name: 'Plan issues', filters: { changedLabels: ['factory:needs-plan'] }, nextRunAt: new Date(Date.now() + 60_000).toISOString() }] })
    renderRoute()
    const refinement = await screen.findByRole('region', { name: 'Refinement' })
    expect(within(refinement).getByText(/outside implementation queue; this lane handles planning/)).toBeTruthy()
    expect(within(refinement).getByText('planning')).toBeTruthy()
    const refinementPreview = within(refinement).getByTestId('dispatch-preview-Refinement')
    expect(within(refinementPreview).getByText('o/r#1')).toBeTruthy()
    expect(within(refinementPreview).getByText('Plan issues')).toBeTruthy()
    expect(within(refinementPreview).getByText(/Next automation check: ~about/)).toBeTruthy()
    const ready = screen.getByRole('region', { name: 'Ready' })
    expect(within(ready).getByText(/conflict-file: file overlap with o\/r#9/)).toBeTruthy()
    expect(within(ready).getByText('conflict')).toBeTruthy()
    expect(screen.getByText(/Merge debt: 1 open \(1 need an integration agent\)/)).toBeTruthy()
    expect(screen.getByText(/o\/r#4 ↔ o\/r#5 — needs-agent \(#77\)/)).toBeTruthy()
    expect(screen.getByText(/alice changed basePriority on o\/r#2 — urgent/)).toBeTruthy()
    expect(await screen.findByText(/Needs a human decision: o\/r#8/)).toBeTruthy()
    expect(screen.getByText(/o\/r#3 — score 700/)).toBeTruthy()
  })

  it('sends the card revision with a priority edit and surfaces a stale-revision rejection', async () => {
    getBacklog.mockResolvedValue(data)
    getBacklogRecommendation.mockResolvedValue({ next: null, top: [], needsHuman: [] })
    getAutomations.mockResolvedValue({ automations: [] })
    editBacklogIssue.mockRejectedValue(new Error('o/r#2 is at revision 6, caller read 5'))
    renderRoute()
    const select = await screen.findByLabelText('Priority for o/r#2')
    fireEvent.change(select, { target: { value: 'P0' } })
    await waitFor(() => expect(editBacklogIssue).toHaveBeenCalled())
    expect(editBacklogIssue.mock.calls[0]![0]).toEqual({ number: 2, expectedRevision: 5, fields: { basePriority: 'P0' } })
    expect((await screen.findByRole('alert')).textContent).toContain('revision 6')
    expect(screen.getByText('No issues are eligible for implementation dispatch from the Ready lane.')).toBeTruthy()
    expect(screen.getByText(/through their own automations/)).toBeTruthy()
    expect((await screen.findByLabelText('Priority for o/r#2')).className).toContain('w-20')
  })
})
