import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { useCodingRunExplorer } = vi.hoisted(() => ({ useCodingRunExplorer: vi.fn() }))
vi.mock('@/api/queries', () => ({ useCodingRunExplorer: (...args: unknown[]) => useCodingRunExplorer(...args) }))
vi.mock('@/api/client', () => ({ codingRunEvidenceUrl: (_issue: number, runId: string, sha: string) => `/evidence/${runId}/${sha}` }))
vi.mock('@/lib/project-router', () => ({ Link: ({ to, ...props }: ComponentProps<'a'> & { to: string }) => <a href={to} {...props} /> }))

import { IssueRunExplorer } from './issue-run-explorer'

const baseRun = {
  runId: 'run-1', issueNumber: 42, status: 'flaky', integrity: 'valid', startedAt: '2026-11-10T08:00:00.000Z',
  worker: { availability: 'available', value: { workerId: 'worker-a' } },
  agent: { availability: 'available', value: { provider: 'codex', adapterId: 'codex-cli' } },
  model: { availability: 'unknown' }, pullRequest: { availability: 'available', value: { number: 7 } },
  commits: ['c'.repeat(40)], validationCount: 1, latestValidationAt: '2026-11-10T08:01:00.000Z',
  attemptCount: 2, attempts: [
    { attemptId: 'attempt-1', index: 1, status: 'failed', startedAt: '2026-11-10T08:00:00.000Z' },
    { attemptId: 'attempt-2', index: 2, status: 'completed', startedAt: '2026-11-10T08:02:00.000Z', supersedesAttemptId: 'attempt-1' },
  ], eventCount: 1,
  timeline: [{ eventId: 'event-1', type: 'validation.completed', occurredAt: '2026-11-10T08:01:00.000Z', evidenceCount: 1 }],
  timelineTruncated: false,
  evidence: [{ evidenceId: 'receipt-1', kind: 'artifact', sha256: 'a'.repeat(64), availability: 'available', downloadUrl: '/path' }],
  evidenceCount: 1, evidenceComplete: true,
  trace: { availability: 'available', traceId: 'b'.repeat(32), url: 'https://langfuse.example/project/p/traces/trace' },
}

describe('issue run explorer', () => {
  afterEach(() => cleanup())
  beforeEach(() => useCodingRunExplorer.mockReset())

  it('renders readable status, evidence links, timeline and external trace links', () => {
    useCodingRunExplorer.mockReturnValue({ data: { pages: [{ runs: [baseRun] }] }, isPending: false, isError: false, hasNextPage: false })
    render(<IssueRunExplorer issueNumber={42} issueBlocked />)
    expect(screen.getByRole('heading', { name: 'Issue run history' })).toBeTruthy()
    expect(screen.getByLabelText('Status: Flaky')).toBeTruthy()
    expect(screen.getByText('Worker:')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open Langfuse trace \(project access required\)/ }).getAttribute('href')).toBe(baseRun.trace.url)
    expect(screen.getByRole('link', { name: 'artifact · receipt-1' }).getAttribute('href')).toBe(`/evidence/run-1/${'a'.repeat(64)}`)
    expect(screen.getByRole('list', { name: 'Timeline for run-1' })).toBeTruthy()
    expect(screen.getByText('Complete')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Attempts for run-1' }).textContent).toContain('retry after attempt-1')
    expect(screen.getByText(/Check its latest GitHub comments/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Verification history' }).getAttribute('href')).toBe('/verification')
  })

  it('presents unavailable records without hiding the detail section and supports keyboard paging', () => {
    const fetchNextPage = vi.fn()
    useCodingRunExplorer.mockReturnValue({ data: { pages: [{ runs: [{ ...baseRun, status: 'unknown', integrity: 'corrupt', trace: { availability: 'unavailable', reason: 'offline' } }] }] }, isPending: false, isError: false, hasNextPage: true, isFetchingNextPage: false, fetchNextPage })
    render(<IssueRunExplorer issueNumber={42} />)
    expect(screen.getByLabelText('Status: Unknown')).toBeTruthy()
    expect(screen.getByText('Ledger record integrity: corrupt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load older runs' }))
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it('keeps waiting, blocked, untested, failed, and unknown text states distinct', () => {
    const statuses = ['waiting', 'blocked', 'untested', 'failed', 'unknown'] as const
    useCodingRunExplorer.mockReturnValue({
      data: { pages: [{ runs: statuses.map((status, index) => ({ ...baseRun, runId: `run-${index}`, status, integrity: status === 'unknown' ? 'corrupt' : 'valid', validationCount: 0 })) }] },
      isPending: false, isError: false, hasNextPage: false,
    })
    render(<IssueRunExplorer issueNumber={42} />)
    for (const status of statuses) expect(screen.getByLabelText(`Status: ${status[0]!.toUpperCase()}${status.slice(1)}`)).toBeTruthy()
  })

  it('marks absent ledger data as unknown and degrades clearly on request failure', () => {
    useCodingRunExplorer.mockReturnValue({ data: { pages: [{ runs: [] }] }, isPending: false, isError: false, hasNextPage: false })
    const { rerender } = render(<IssueRunExplorer issueNumber={42} />)
    expect(screen.getByText(/Run history is unknown/)).toBeTruthy()
    useCodingRunExplorer.mockReturnValue({ data: undefined, isPending: false, isError: true, hasNextPage: false })
    rerender(<IssueRunExplorer issueNumber={42} />)
    expect(screen.getByText(/Run history is unavailable/)).toBeTruthy()
  })
})
