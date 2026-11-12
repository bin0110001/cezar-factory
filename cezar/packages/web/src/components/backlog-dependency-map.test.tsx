import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

const getDependencyStalls = vi.fn()
vi.mock('@/api/client', () => ({ ApiError: class ApiError extends Error { status = 503 }, getDependencyStalls: (...a: unknown[]) => getDependencyStalls(...a) }))

import { BacklogDependencyMap, layoutDependencyMap } from './backlog-dependency-map'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const id = (n: number) => `issue:o/r:${n}`
const item = (n: number, cls: string, blockerIds: string[] = [], extra: object = {}) => ({ nodeId: id(n), number: n, title: `Issue ${n}`, class: cls, rootCauseIds: [], blockerIds, detail: 'detail', ...extra })

describe('layoutDependencyMap', () => {
  it('puts blockers left of what they block and keeps cycles from inflating depth', () => {
    const layout = layoutDependencyMap({ items: [item(1, 'runnable') as never, item(2, 'blocked', [id(1)]) as never, item(3, 'blocked', [id(2)]) as never], cycles: [] })
    expect(layout.positions.get(id(1))!.x).toBeLessThan(layout.positions.get(id(2))!.x)
    expect(layout.positions.get(id(2))!.x).toBeLessThan(layout.positions.get(id(3))!.x)
    const cyclic = layoutDependencyMap({ items: [item(1, 'stuck', [id(2)]) as never, item(2, 'stuck', [id(1)]) as never], cycles: [[id(1), id(2)]] })
    expect(cyclic.edges.every((edge) => edge.cycle)).toBe(true)
    expect(cyclic.width).toBeLessThan(1000)
  })
  it('draws decision and external blockers as their own nodes', () => {
    const layout = layoutDependencyMap({ items: [item(5, 'waiting', ['decision:o/r:d1']) as never], cycles: [] })
    expect(layout.nodes.get('decision:o/r:d1')?.cls).toBe('external')
  })
})

describe('BacklogDependencyMap', () => {
  const renderMap = () => render(<QueryClientProvider client={createQueryClient()}><BacklogDependencyMap /></QueryClientProvider>)

  it('calls out a stall, the cycle, and every issue with its blockers', async () => {
    getDependencyStalls.mockResolvedValue({
      revision: 1, verdict: 'stalled', summary: 'No work can progress: 2 issue(s) are stuck and 0 are waiting.',
      counts: { running: 0, runnable: 0, blocked: 0, waiting: 0, stuck: 2 }, cycles: [[id(1), id(2)]],
      items: [item(1, 'stuck', [id(2)], { reason: 'dependency-cycle' }), item(2, 'stuck', [id(1)], { reason: 'dependency-cycle' })],
    })
    renderMap()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Work is stalled/))
    expect(screen.getByLabelText('Dependency cycles').textContent).toContain('#1 ⇄ #2')
    expect(screen.getByTestId('map-row-1').textContent).toContain('#2')
  })

  it('treats waiting on input as an acceptable stop, not an alarm', async () => {
    getDependencyStalls.mockResolvedValue({
      revision: 1, verdict: 'waiting', summary: 'Nothing is runnable; 1 issue(s) are waiting on a person, decision or outside information.',
      counts: { running: 0, runnable: 0, blocked: 0, waiting: 1, stuck: 0 }, cycles: [], items: [item(7, 'waiting', [], { reason: 'waiting-on-human' })],
    })
    renderMap()
    await waitFor(() => expect(screen.getByText(/acceptable stopping point/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the error when the map cannot load', async () => {
    getDependencyStalls.mockRejectedValue(new Error('graph offline'))
    renderMap()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/graph offline/), { timeout: 5000 })
  })
})
