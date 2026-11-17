import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Candidate, ReleaseCandidatesResponse } from '@open-mercato/cezar-api-client'
import { ReleaseCandidatesSection, stateKind } from './release-candidates'

afterEach(() => cleanup())

const sha = (c: string) => c.repeat(40)
const base: Candidate = {
  id: 'cand-1', projectId: 'tableflux', state: 'validating', revision: 2, devSha: sha('a'), baseStableSha: sha('b'), candidateSha: sha('c'), configHash: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-11-16T08:00:00.000Z', updatedAt: '2026-11-16T11:00:00.000Z', lease: { owner: 'worker-1', expiresAt: '2099-01-01T00:00:00.000Z', stale: false },
  tests: { status: 'running', shards: { total: 4, passed: 2, failed: 1 }, assetVersion: 'v7' }, devDrift: { commitsAhead: 3, newestDevSha: sha('e') },
  blockers: [], repairObligations: [], receipts: [], pending: { count: 0, coalescedReason: null, triggers: [] }, nextScheduledAttempt: null,
  links: { pullRequests: [12], issues: [34] }, warnings: [], checkMatrix: [],
}
const response = (active: Candidate | null, over: Partial<ReleaseCandidatesResponse['projects'][number]> = {}): ReleaseCandidatesResponse => ({
  schemaVersion: 1, generatedAt: '2026-11-16T12:00:00.000Z', available: true, snapshotAt: '2026-11-16T11:59:00.000Z',
  projects: [{ projectId: 'tableflux', active, history: [], scheduledChecks: [], aiAudit: [], warnings: [], ...over }],
})
const show = (data: ReleaseCandidatesResponse | undefined, extra: object = {}) => render(<ReleaseCandidatesSection query={{ data, ...extra }} />)

describe('release candidates view', () => {
  it('shows every field of an in-progress candidate', () => {
    show(response(base))
    const card = within(screen.getByTestId('candidate-cand-1'))
    expect(card.getByTestId('candidate-state').textContent).toBe('Validating')
    expect(card.getByText('aaaaaaaaaaaa')).toBeTruthy()
    expect(card.getByText('bbbbbbbbbbbb')).toBeTruthy()
    expect(card.getByText(/2\/4 shards passed · 1 failed · assets v7/)).toBeTruthy()
    expect(card.getByText(/3 commit\(s\) ahead/)).toBeTruthy()
    expect(card.getByText(/PR #12, issue #34/)).toBeTruthy()
    expect(card.getByText(/revision 2/)).toBeTruthy()
  })

  it('shows human approval as a waiting state, visibly different from a failure', () => {
    const { unmount } = show(response({ ...base, state: 'awaiting-approval' }))
    const waiting = screen.getByTestId('candidate-cand-1')
    expect(waiting.getAttribute('data-kind')).toBe('awaiting-approval')
    expect(screen.getByTestId('candidate-state').textContent).toBe('Waiting for human approval')
    expect(screen.getByRole('status').textContent).toContain('Nothing has failed')
    expect(screen.queryByRole('alert')).toBeNull()
    unmount()
    show(response({ ...base, state: 'failed' }))
    expect(screen.getByTestId('candidate-cand-1').getAttribute('data-kind')).toBe('failure')
    expect(screen.getByRole('alert').textContent).toContain('ended as failed')
    expect(screen.queryByText(/Nothing has failed/)).toBeNull()
  })

  it('classifies every state', () => {
    expect(stateKind('awaiting-approval')).toBe('awaiting-approval')
    for (const s of ['failed', 'abandoned', 'canceled'] as const) expect(stateKind(s)).toBe('failure')
    expect(stateKind('promoted')).toBe('done')
    for (const s of ['requested', 'validating', 'repair-required', 'ready', 'promoting', 'activating'] as const) expect(stateKind(s)).toBe('in-progress')
  })

  it('shows the queue: coalesced triggers, next attempt, and a stale lease', () => {
    show(response({ ...base, pending: { count: 3, coalescedReason: 'a candidate is already active', triggers: ['schedule', 'change'] }, nextScheduledAttempt: '2026-11-17T03:00:00.000Z', lease: { owner: 'worker-1', expiresAt: '2026-11-16T10:00:00.000Z', stale: true } }))
    const queue = within(screen.getByLabelText('Queue and lease'))
    expect(queue.getByText(/Pending triggers:/).textContent).toContain('3')
    expect(queue.getByText(/schedule, change/)).toBeTruthy()
    expect(queue.getByText(/Coalesced because: a candidate is already active/)).toBeTruthy()
    expect(queue.getByTestId('stale-lease').textContent).toMatch(/owner may have crashed/)
    expect(queue.queryByText('Not scheduled')).toBeNull()
  })

  it('shows blockers, forward-port blockers, receipts and warnings', () => {
    show(response({
      ...base, blockers: [{ code: 'scan', message: 'critical CVE' }],
      repairObligations: [{ id: 'fp-1', state: 'conflict', blocksStable: true }, { id: 'fp-2', state: 'applied', blocksStable: true }],
      receipts: [{ id: 'r1', kind: 'promotion', at: '2026-11-16T09:00:00.000Z', ok: true }],
      warnings: [{ kind: 'adapter', message: 'no adapter for suite e2e' }, { kind: 'worker', message: 'no worker has display capability' }],
    }))
    expect(within(screen.getByLabelText('Blockers')).getByText('critical CVE')).toBeTruthy()
    expect(screen.getByTestId('forward-port-blocker').textContent).toContain('1 unresolved forward-port')
    expect(within(screen.getByLabelText('Promotion receipts')).getByText(/promotion · ok/)).toBeTruthy()
    const warnings = within(screen.getByLabelText('Candidate warnings'))
    expect(warnings.getByText(/adapter:/)).toBeTruthy()
    expect(warnings.getByText(/worker:/)).toBeTruthy()
  })

  it('distinguishes blocking from advisory checks and shows new versus known findings and waivers', () => {
    show(response({ ...base, checkMatrix: [
      { category: 'sca', status: 'fail', blocking: true, newFindings: 1, knownFindings: 39, provider: { name: 'trivy', version: '0.60.0' }, feed: 'fresh', scope: 'full-repo', sbomDigest: null, activeWaivers: 0 },
      { category: 'lint', status: 'warn', blocking: false, newFindings: 0, knownFindings: 2, provider: null, feed: 'not-applicable', scope: null, sbomDigest: null, activeWaivers: 1 },
    ] }))
    const sca = within(screen.getByTestId('check-sca'))
    expect(sca.getByText('Blocking')).toBeTruthy()
    expect(sca.getByText('1 / 39')).toBeTruthy()
    expect(sca.getByText(/trivy 0.60.0/)).toBeTruthy()
    const lint = within(screen.getByTestId('check-lint'))
    expect(lint.getByText('Advisory')).toBeTruthy()
    expect(lint.getByText('1')).toBeTruthy()
  })

  it('renders unavailable, empty, loading, error, no-active and integrity-warning states honestly', () => {
    const view = show({ schemaVersion: 1, generatedAt: '2026-11-16T12:00:00.000Z', available: false, snapshotAt: null, projects: [] })
    expect(screen.getByText(/has not published a candidate snapshot/)).toBeTruthy()
    view.unmount()
    const loading = render(<ReleaseCandidatesSection query={{ isPending: true }} />)
    expect(screen.getByRole('status').textContent).toContain('Loading')
    loading.unmount()
    const failed = render(<ReleaseCandidatesSection query={{ isError: true, error: new Error('offline') }} />)
    expect(screen.getByRole('alert').textContent).toContain('offline')
    failed.unmount()
    const none = show(response(null, { history: [{ ...base, state: 'promoted' }] }))
    expect(screen.getByTestId('no-active-tableflux').textContent).toContain('no active candidate. Last: Promoted.')
    none.unmount()
    show(response(base, { warnings: ['integrity: 2 nonterminal candidates for one project (only one is allowed); showing the most recently updated'] }))
    expect(screen.getByRole('alert').textContent).toContain('integrity: 2 nonterminal')
  })
})
