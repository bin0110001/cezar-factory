import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowExecutionView } from '@open-mercato/cezar-contract'
import { getRunWorkflowView } from '@/api/client'

import { WorkflowExecutionPanel } from './workflow-execution-panel'

vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  getRunWorkflowView: vi.fn(),
}))

const view: WorkflowExecutionView = {
  runId: 'root-run', status: 'waiting', definitionDigest: 'a'.repeat(64), policyPins: [], outcomes: {}, ready: [],
  workflow: {
    id: 'factory.review', version: '1.0.0', digest: 'b'.repeat(64), entry: 'implement', terminals: ['review'],
    compatibility: { mode: 'versioned-only' }, budget: { maxAttempts: 8 }, policyRefs: [],
    nodes: [{ id: 'implement', kind: 'agent', outcomes: ['passed'], session: 'continue', inputs: [], outputs: [] }], transitions: [],
  },
  wait: { node: 'review', reason: 'human', actor: 'authorized human operator', detail: 'approval needed' },
  budget: { maxAttempts: 8, usedAttempts: 3, remainingAttempts: 5 },
  nodeProgress: [{ node: 'implement', state: 'completed', outcome: 'passed' }, { node: 'verify', state: 'current' }],
  attempts: [{ node: 'verify', attempt: 1, status: 'done', startedAt: '2026-01-01T00:00:00Z', outcome: 'changes_required', errorPresent: false,
    outputs: { artifactRevision: 'sha256:abcd', costUsd: 0.125, coverage: { coveredPaths: ['src/a.ts'], excludedPaths: ['generated/a.ts'] },
      reviewLineage: { previousVerificationId: 'verification-old', sameSessionRepair: true },
      findings: [{ fingerprint: 'c'.repeat(64), title: 'Finding A', path: 'src/a.ts', line: 4, provenance: 'ai-review', verificationState: 'unverified', reviewerSessionId: 'review-session' }] } }],
  children: [], githubApproval: 'not-in-workflow-record',
}

describe('WorkflowExecutionPanel', () => {
  afterEach(() => vi.clearAllMocks())

  it('explains the wait owner and exposes expandable revision-bound review evidence', async () => {
    vi.mocked(getRunWorkflowView).mockResolvedValue(view)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><WorkflowExecutionPanel runId="root-run" enabled /></QueryClientProvider>)

    expect(await screen.findByText(/authorized human operator can unblock it/)).toBeTruthy()
    expect(screen.getByText(/Attempt budget: 3\/8 used · 5 remaining/)).toBeTruthy()
    expect(screen.getByText(/GitHub approval is separate/)).toBeTruthy()
    expect(screen.queryByText(/Backlog issue/)).toBeNull()
    fireEvent.click(screen.getByText(/Review evidence/))
    expect(screen.getByText(/excluded: generated\/a\.ts/)).toBeTruthy()
    expect(screen.getByText(/repair reused the implementation session/)).toBeTruthy()
    expect(screen.getByText(/ai-review · unverified/)).toBeTruthy()
  })
})
