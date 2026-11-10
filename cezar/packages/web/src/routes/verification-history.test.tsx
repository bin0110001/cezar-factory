import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VerificationQueryResponse } from '@open-mercato/cezar-api-client'
import { getVerificationArtifact, queryVerificationHistory } from '@/api/client'
import { VerificationHistoryRoute } from './verification-history'

vi.mock('@/api/client', () => ({
  getVerificationArtifact: vi.fn(),
  queryVerificationHistory: vi.fn(),
}))

afterEach(() => { cleanup(); vi.clearAllMocks() })

function page(kind: VerificationQueryResponse['kind'], items: unknown[], hasMore = false): VerificationQueryResponse {
  return {
    schemaVersion: 1,
    kind,
    query: { runId: '', status: '', pageSize: 25 },
    items,
    page: { returned: items.length, hasMore, nextCursor: hasMore ? 'next-cursor' : null },
    limits: { inlineBytes: 2_048, excerptChars: 512, maxResponseBytes: 262_144 },
  } as VerificationQueryResponse
}

function renderRoute() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    client,
    ...render(createElement(QueryClientProvider, { client }, createElement(VerificationHistoryRoute))),
  }
}

describe('verification history route', () => {
  it('shows run details, selection explanations, recurrence, trends and lazy artifact evidence', async () => {
    vi.mocked(queryVerificationHistory).mockImplementation(async (input) => {
      switch (input.kind) {
        case 'runs': return page('runs', [{
          id: 'verify-ui', startedAt: '2026-11-09T10:00:00.000Z', finishedAt: '2026-11-09T10:00:01.000Z',
          status: 'failed', commitSha: 'a'.repeat(40), baseSha: '', baselineRunId: null, suite: 'quick', projectId: 'shop', cezarRunId: 'agent-run-1', githubIssueUrl: 'https://github.com/acme/project/issues/42',
          environment: { platform: 'linux', token: '[REDACTED]' }, coverage: { selected: 2, passed: 0, failed: 1, skipped: 0, unknown: 1 },
          counts: { selected: 1, deferred: 1, failures: 1, episodes: 1, artifacts: 1 },
          checks: [{ checkId: 'unit', status: 'failed', durationMs: 125, metrics: [{ name: 'cases', value: 7, unit: 'tests' }], findingFingerprint: 'f'.repeat(64) }],
        }])
        case 'selected': return input.cursor
          ? page('selected', [{ runId: 'verify-ui', testId: 'integration', reason: { bytes: 31, sha256: '6'.repeat(64), truncated: false, content: 'Selected by dependency impact.', head: null, tail: null, reference: 'run:verify-ui/selected/integration' } }])
          : page('selected', [{ runId: 'verify-ui', testId: 'unit', reason: { bytes: 23, sha256: '1'.repeat(64), truncated: false, content: 'Included in suite quick.', head: null, tail: null, reference: 'run:verify-ui/selected/unit' } }], true)
        case 'deferred': return page('deferred', [{ runId: 'verify-ui', testId: 'browser', reason: { bytes: 24, sha256: '2'.repeat(64), truncated: false, content: 'Not included in suite quick.', head: null, tail: null, reference: 'run:verify-ui/deferred/browser' } }])
        case 'failures': return page('failures', [
          { runId: 'verify-ui', id: 'unit:1', testId: 'unit', status: 'failed', classification: 'new', episodeId: 'f'.repeat(64), message: { bytes: 11, sha256: '3'.repeat(64), truncated: false, content: 'expected true', head: null, tail: null, reference: 'run:verify-ui/failures/unit' }, output: { bytes: 11, sha256: '4'.repeat(64), truncated: false, content: 'test failed', head: null, tail: null, reference: 'run:verify-ui/failures/unit/output' } },
          { runId: 'verify-ui', id: 'unit:2', testId: 'unit retry', status: 'failed', classification: 'new', episodeId: 'f'.repeat(64), message: { bytes: 13, sha256: '7'.repeat(64), truncated: false, content: 'retry failed', head: null, tail: null, reference: 'run:verify-ui/failures/unit-retry' }, output: { bytes: 12, sha256: '8'.repeat(64), truncated: false, content: 'retry output', head: null, tail: null, reference: 'run:verify-ui/failures/unit-retry/output' } },
        ])
        case 'episodes': return page('episodes', [{ runId: 'verify-ui', id: 'f'.repeat(64), fingerprint: 'f'.repeat(64), status: 'open', firstSeenAt: '2026-11-09T10:00:00.000Z', lastSeenAt: '2026-11-09T10:00:00.000Z', occurrences: 1 }])
        case 'artifacts': return page('artifacts', [{ runId: 'verify-ui', id: 'verify-ui-abc', name: 'build.log', path: 'artifacts/build.log', mediaType: 'text/plain', data: { bytes: 10_000, sha256: '5'.repeat(64), truncated: true, content: null, head: 'preview', tail: 'tail', reference: 'run:verify-ui/artifacts/verify-ui-abc' } }])
        case 'baseline': return page('baseline', [])
      }
    })
    vi.mocked(getVerificationArtifact).mockResolvedValue({ content: 'safe build evidence', bytes: 19, sha256: '5'.repeat(64), truncated: false })
    const { client } = renderRoute()

    const runButton = await screen.findByRole('button', { name: /verify-ui/ })
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0)
    fireEvent.click(runButton)

    expect(await screen.findByText('Included in suite quick.')).toBeTruthy()
    expect(screen.getByText('Not included in suite quick.')).toBeTruthy()
    expect(screen.getByText('Selected by dependency impact.')).toBeTruthy()
    expect(screen.getByText('new')).toBeTruthy()
    expect(screen.getByTestId(`verification-failure-group-${'f'.repeat(64)}`).textContent).toContain('2 failures')
    expect(screen.getByRole('link', { name: 'View recurrence episode' }).getAttribute('href')).toBe(`#verification-episode-${'f'.repeat(64)}`)
    expect(screen.getByRole('link', { name: 'View run evidence' }).getAttribute('href')).toBe('#verification-artifacts')
    expect(screen.getByText(/1 occurrence/)).toBeTruthy()
    expect(screen.getByText('125 ms')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Cezar agent work' }).getAttribute('href')).toBe('/p/shop/tasks/agent-run-1')
    expect(screen.getByRole('link', { name: 'Open linked GitHub issue' }).getAttribute('href')).toBe('https://github.com/acme/project/issues/42')
    expect(screen.getByText(/0 passed · 1 failed · 0 skipped · 1 unknown of 2 selected/)).toBeTruthy()
    expect(screen.getByText('platform')).toBeTruthy()
    expect(screen.getByText('[REDACTED]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'unit' }))
    expect(screen.getByText('Coverage: failed')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Stable link to this check' }).getAttribute('href')).toBe('?runId=verify-ui&testId=unit')
    fireEvent.click(screen.getByRole('button', { name: 'browser' }))
    expect(screen.getByText('Coverage limitation: this check was deferred, so this run has no result for it.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Load evidence/ }))
    expect(await screen.findByText('safe build evidence')).toBeTruthy()
    expect(getVerificationArtifact).toHaveBeenCalledWith('verify-ui', 'verify-ui-abc', expect.any(Object))
    client.clear()
  })

  it('shows an explicit empty state and a query error state', async () => {
    vi.mocked(queryVerificationHistory).mockResolvedValueOnce(page('runs', []))
    const first = renderRoute()
    expect(await screen.findByText('No verification runs yet')).toBeTruthy()
    first.unmount()
    first.client.clear()

    vi.mocked(queryVerificationHistory).mockRejectedValueOnce(new Error('offline'))
    renderRoute()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline'))
  })

  it('keeps run pagination ordered and supports returning to the prior page', async () => {
    vi.mocked(queryVerificationHistory).mockImplementation(async (input) => {
      if (input.kind !== 'runs') return page(input.kind, [])
      return input.cursor
        ? page('runs', [{ id: 'older-run', startedAt: '2026-11-08T10:00:00.000Z', finishedAt: '2026-11-08T10:00:01.000Z', status: 'passed', commitSha: 'b'.repeat(40), baseSha: '', baselineRunId: null, counts: { selected: 0, deferred: 0, failures: 0, episodes: 0, artifacts: 0 }, checks: [] }])
        : page('runs', [{ id: 'newer-run', startedAt: '2026-11-09T10:00:00.000Z', finishedAt: '2026-11-09T10:00:01.000Z', status: 'passed', commitSha: 'a'.repeat(40), baseSha: '', baselineRunId: null, counts: { selected: 0, deferred: 0, failures: 0, episodes: 0, artifacts: 0 }, checks: [] }], true)
    })
    renderRoute()
    expect(await screen.findByRole('button', { name: /newer-run/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('button', { name: /older-run/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(await screen.findByRole('button', { name: /newer-run/ })).toBeTruthy()
  })
})
