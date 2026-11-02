import { describe, expect, it } from 'vitest'
import type { DependencySimulationResult } from '@/api/client'
import { sanitizeDependencyScenarioExport } from './dependency-scenario-export'

describe('sanitizeDependencyScenarioExport', () => {
  it('pins the repository and revision while omitting edge provenance and source evidence', () => {
    const simulation: DependencySimulationResult = {
      repository: 'acme/project',
      revision: 12,
      persisted: false,
      freshness: 'fresh',
      scenario: {
        addEdges: [{
          id: 'candidate-edge',
          kind: 'BLOCKS',
          from: 'issue:1',
          to: 'issue:2',
          direction: 'from-to',
          provenance: {
            origin: 'human',
            authority: 'proposed',
            confidence: 1,
            recordedAt: '2026-11-01T12:00:00.000Z',
            sourceUrl: 'https://private.example/evidence',
            evidence: [{ label: 'sensitive evidence', url: 'https://private.example/detail' }],
          },
          createdAt: '2026-11-01T12:00:00.000Z',
          updatedAt: '2026-11-01T12:00:00.000Z',
        }],
        removeEdgeIds: [],
        completeNodeIds: [],
        resolveDecisionIds: [],
      },
      before: [],
      after: [],
      summary: {
        before: { totalOpenIssues: 0, ready: 0, blocked: 0, unknown: 0, cycleCount: 0 },
        after: { totalOpenIssues: 0, ready: 0, blocked: 0, unknown: 0, cycleCount: 0 },
        changes: { ready: 0, blocked: 0, unknown: 0, cycles: 0 },
        changedReadiness: [],
        addedCycles: [],
        removedCycles: [],
        truncatedDetails: false,
      },
      hypotheticalCompletions: [],
      hypotheticalDecisionOutcomes: [],
      criticalPath: { status: 'unavailable', reason: 'No duration estimates.' },
      cyclesBefore: [],
      cyclesAfter: [],
      truncatedCycles: false,
    }

    const safe = sanitizeDependencyScenarioExport(simulation)
    const serialized = JSON.stringify(safe)

    expect(safe).toMatchObject({ repository: 'acme/project', revision: 12, persisted: false })
    expect(safe.scenario.addedEdges).toEqual([{ id: 'candidate-edge', kind: 'BLOCKS', from: 'issue:1', to: 'issue:2' }])
    expect(serialized).not.toContain('private.example')
    expect(serialized).not.toContain('sensitive evidence')
    expect(serialized).not.toContain('provenance')
  })
})
