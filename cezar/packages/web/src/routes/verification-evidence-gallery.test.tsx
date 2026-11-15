import { createElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VerificationEvidenceResponse } from '@open-mercato/cezar-api-client'
import { getVerificationEvidence } from '@/api/client'
import { VerificationEvidenceGallery } from './verification-evidence-gallery'

vi.mock('@/api/client', () => ({
  getVerificationEvidence: vi.fn(),
  verificationEvidenceContentUrl: (run: string, id: string, d: string) => `/evidence/${run}/${id}?disposition=${d}`,
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const renderer = { os: 'linux', renderer: 'software', displayBackend: 'x11', appVersion: 'godot' }
const item = (id: string, side: 'expected' | 'actual' | 'diff' | 'other', role: string, over: Record<string, unknown> = {}) => ({
  id, kind: side === 'diff' ? 'diff' : 'png', side, role, sessionId: `s-${role}`, attempt: 1, capturedAt: '2026-11-10T10:00:00.000Z', mediaType: 'image/png', bytes: 10,
  sha256: 'a'.repeat(64), accessPolicy: 'project', redactionState: 'redacted', retention: 'p30d', preview: 'available', download: 'available', renderer, ...over,
})
function evidence(over: Partial<VerificationEvidenceResponse>): VerificationEvidenceResponse {
  return { schemaVersion: 1, verificationId: 'v', commitSha: '1'.repeat(40), manifestSha256: '2'.repeat(64), policyVersions: ['p1'], state: 'current', outcome: 'failed', groups: [], timeline: [], ...over } as VerificationEvidenceResponse
}
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(VerificationEvidenceGallery, { verificationId: 'v', commitSha: '1'.repeat(40) })))
}

describe('VerificationEvidenceGallery', () => {
  it('renders expected/actual/diff previews, downloads and the timeline', async () => {
    vi.mocked(getVerificationEvidence).mockResolvedValue(evidence({
      groups: [{ testId: 'scene', outcome: 'failed', reason: 'pixels differ', checkStatus: 'failed', roles: ['expected', 'actual'], missingRoles: [], rendererMismatch: [], withheld: 0, items: [item('e', 'expected', 'expected'), item('a', 'actual', 'actual'), item('d', 'diff', 'diff')] }] as never,
      timeline: [{ capturedAt: '2026-11-10T10:00:00.000Z', testId: 'scene', role: 'actual', sessionId: 's-actual', itemId: 'a', kind: 'png' }],
    }))
    show()
    await waitFor(() => expect(screen.getByTestId('evidence-group-scene')).toBeTruthy())
    expect(screen.getByAltText('Expected capture for expected').getAttribute('src')).toBe('/evidence/v/e?disposition=preview')
    expect(screen.getByAltText('Diff capture for diff')).toBeTruthy()
    expect(screen.getAllByText('Download')).toHaveLength(3)
    expect(screen.getByLabelText('Session timeline')).toBeTruthy()
  })

  it('shows withheld previews, missing roles and incomplete outcomes, never a pass', async () => {
    vi.mocked(getVerificationEvidence).mockResolvedValue(evidence({
      outcome: 'incomplete',
      groups: [{ testId: 'scene', outcome: 'incomplete', reason: 'missing capture for role guest', checkStatus: 'passed', roles: ['host'], missingRoles: ['guest'], rendererMismatch: [], withheld: 1, items: [item('h', 'other', 'host', { preview: 'denied', download: 'denied', redactionState: 'unredacted' })] }] as never,
    }))
    show()
    await waitFor(() => expect(screen.getByText('Missing roles: guest')).toBeTruthy())
    expect(screen.getByText(/Preview withheld/)).toBeTruthy()
    expect(screen.queryByText('Download')).toBeNull()
    expect(screen.getByTestId('evidence-missing-Expected')).toBeTruthy()
    expect(screen.getByText(/1 item\(s\) withheld/)).toBeTruthy()
  })

  it('renders nothing when a run has no visual evidence', async () => {
    vi.mocked(getVerificationEvidence).mockResolvedValue(evidence({ state: 'none', outcome: null }))
    show()
    await waitFor(() => expect(getVerificationEvidence).toHaveBeenCalled())
    expect(screen.queryByTestId('verification-visual-evidence')).toBeNull()
  })
})
