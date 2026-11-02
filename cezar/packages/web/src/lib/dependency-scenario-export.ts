import type { DependencySimulationResult } from '@/api/client'

/** Share only the scenario and its aggregate results; source evidence and issue content stay local. */
export function sanitizeDependencyScenarioExport(simulation: DependencySimulationResult) {
  return {
    schemaVersion: 1 as const,
    repository: simulation.repository,
    revision: simulation.revision,
    persisted: false as const,
    freshness: simulation.freshness,
    scenario: {
      addedEdges: simulation.scenario.addEdges.map(({ id, kind, from, to }) => ({ id, kind, from, to })),
      removedEdgeIds: simulation.scenario.removeEdgeIds,
      completedIssueIds: simulation.scenario.completeNodeIds,
      resolvedDecisionIds: simulation.scenario.resolveDecisionIds,
    },
    summary: simulation.summary,
    criticalPath: simulation.criticalPath,
  }
}
