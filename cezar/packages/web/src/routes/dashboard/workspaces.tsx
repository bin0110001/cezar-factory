import { useWorkspaceLifecycle, useWorkspaceLifecycleAction } from '@/api/dashboard-workspaces'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { shortAge } from '@/lib/format'

const stateLabel: Record<string, string> = {
  claimed: 'Claimed', working: 'Working', validating: 'Validating', ready: 'Ready',
  integrating: 'Integrating', blocked: 'Blocked', integrated: 'Integrated',
  cleanup_pending: 'Cleanup pending', closed: 'Closed', failed: 'Failed', recoverable: 'Recoverable',
}

export function WorkspaceLifecycle() {
  const query = useWorkspaceLifecycle()
  const action = useWorkspaceLifecycleAction()
  const projects = query.data ?? []
  const active = projects.flatMap((project) => project.records.map((record) => ({ project, record })))
  const overlapCount = projects.reduce((total, project) => total + project.overlaps.length, 0)
  const outboxPending = projects.reduce((total, project) => total + (project.telemetryOutbox?.pending ?? 0), 0)
  const outboxFailed = projects.reduce((total, project) => total + (project.telemetryOutbox?.failed ?? 0), 0)
  const metrics = projects.flatMap((project) => project.metrics ? [project.metrics] : [])
  const metricTotal = (key: 'expiredLeases' | 'cleanupBacklog' | 'validationFailures' | 'manualInterventions' | 'preflightCount' | 'conflictCount' | 'conflictEscalations' | 'autoRepairAttempts' | 'completedIntegrations') =>
    metrics.reduce((total, item) => total + item[key], 0)
  const integrationSamples = metricTotal('completedIntegrations')
  const averageIntegrationMs = integrationSamples
    ? Math.round(metrics.reduce((total, item) => total + (item.averageTimeToIntegrationMs ?? 0) * item.completedIntegrations, 0) / integrationSamples)
    : null
  const preflights = metricTotal('preflightCount')
  const conflicts = metricTotal('conflictCount')

  return (
    <section className="space-y-5" aria-labelledby="workspace-lifecycle-title">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Operations</p>
        <h2 id="workspace-lifecycle-title" className="mt-1 text-xl font-semibold">Workspace lifecycle</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Local ownership, validation, integration, and cleanup across registered projects.
        </p>
      </header>
      {query.isPending && <p role="status" className="text-sm">Loading workspaces…</p>}
      {query.isError && (
        <p role="alert" className="rounded-md border p-4 text-sm">
          Could not read workspace lifecycle state.{' '}
          <button className="underline underline-offset-4" onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {action.isError && (
        <p role="alert" className="rounded-md border border-destructive/40 p-4 text-sm">
          {action.error instanceof Error ? action.error.message : 'Workspace action failed.'}
        </p>
      )}
      {query.data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Summary label="Active workspaces" value={active.length} />
            <Summary label="Ready for integration" value={active.filter(({ record }) => record.state === 'ready').length} />
            <Summary label="Overlap pairs" value={overlapCount} />
            <Summary label="Expired leases" value={metricTotal('expiredLeases')} />
            <Summary label="Cleanup backlog" value={metricTotal('cleanupBacklog')} />
            <Summary label="Telemetry outbox" value={`${outboxPending} pending · ${outboxFailed} failed`} />
            <Summary label="Preflight conflicts" value={preflights ? `${Math.round(conflicts * 100 / preflights)}% · ${conflicts}/${preflights}` : 'No data'} />
            <Summary label="Conflict repair escalations" value={metricTotal('conflictEscalations')} />
            <Summary label="Conflict repair success" value={metrics.some((item) => item.autoRepairSuccessRate !== null)
              ? `${Math.round(metrics.reduce((sum, item) => sum + item.autoRepairSuccesses, 0) * 100 / Math.max(1, metricTotal('autoRepairAttempts')))}% · ${metrics.reduce((sum, item) => sum + item.autoRepairSuccesses, 0)}/${metricTotal('autoRepairAttempts')}`
              : 'No data'} />
            <Summary label="Validation failures" value={metricTotal('validationFailures')} />
            <Summary label="Manual recoveries" value={metricTotal('manualInterventions')} />
            <Summary label="Average time to integration" value={averageIntegrationMs === null ? 'No data' : `${formatDuration(averageIntegrationMs)} · ${integrationSamples} runs`} />
          </div>
          {projects.map((project) => {
            const rows = project.records.filter((record) => !['closed', 'failed'].includes(record.state))
            return (
              <Card key={project.projectId} className="gap-0 p-0">
                <div className="border-b px-4 py-3">
                  <h3 className="font-medium">{project.projectName}</h3>
                  {project.error && <p role="alert" className="mt-1 text-xs text-destructive">{project.error}</p>}
                </div>
                {rows.length === 0 ? (
                  <p className="px-4 py-5 text-sm text-muted-foreground">No active workspaces.</p>
                ) : (
                  <div className="divide-y">
                    {rows.map((record) => (
                      <article key={record.executionId} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_auto]">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <strong className="text-sm">Issue #{record.issue}</strong>
                            <span className="rounded-full border px-2 py-0.5 text-xs">{stateLabel[record.state] ?? record.state}</span>
                            <span className="text-xs text-muted-foreground">{record.origin}</span>
                          </div>
                          <p className="mt-1 truncate font-mono text-xs" title={record.branch}>{record.branch}</p>
                          <p className="mt-1 truncate text-xs text-muted-foreground" title={record.workspacePath}>{record.workspacePath}</p>
                          <p className="mt-1 text-xs text-muted-foreground">Owner {record.ownerId} · updated {shortAge(record.updatedAt)} ago</p>
                        </div>
                        <div className="text-left text-xs text-muted-foreground md:text-right">
                          <div>Fence {record.fencingToken}</div>
                          <div>Lease expires {new Date(record.leaseExpiresAt).toLocaleTimeString()}</div>
                          <div className="mt-2 flex flex-wrap gap-2 md:justify-end">
                            {record.state === 'working' && (
                              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => {
                                if (window.confirm(`Run the configured validation checks for issue #${record.issue}?`))
                                  action.mutate({ projectId: project.projectId, issue: record.issue, action: 'validate' })
                              }}>Retry validation</Button>
                            )}
                            {record.state === 'blocked' && (
                              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => {
                                if (window.confirm(`Resume issue #${record.issue} under its current lifecycle owner? This is recorded in the audit log.`))
                                  action.mutate({ projectId: project.projectId, issue: record.issue, action: 'resume' })
                              }}>Resume blocked work</Button>
                            )}
                            {Date.parse(record.leaseExpiresAt) <= Date.now() && !['integrated', 'cleanup_pending'].includes(record.state) && (
                              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => {
                                if (window.confirm(`Force recover issue #${record.issue}? Confirm that the previous owner process is stopped. The override fences that execution and is recorded in the audit log.`))
                                  action.mutate({ projectId: project.projectId, issue: record.issue, action: 'recover', force: true })
                              }}>Force recover</Button>
                            )}
                            {record.origin === 'factory-created' && ['integrated', 'cleanup_pending'].includes(record.state) && (
                              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => {
                                if (window.confirm(`Remove the clean, integrated workspace for issue #${record.issue}?`))
                                  action.mutate({ projectId: project.projectId, issue: record.issue, action: 'prune' })
                              }}>Retry cleanup</Button>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                {project.overlaps.map((overlap) => (
                  <div key={overlap.issues.join(':')} className="border-t bg-muted/30 px-4 py-3 text-xs">
                    <strong>Advisory overlap: issues #{overlap.issues.join(' and #')}</strong>
                    <p className="mt-1 break-all font-mono text-muted-foreground">{overlap.paths.join(', ')}</p>
                  </div>
                ))}
              </Card>
            )
          })}
          {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects are registered.</p>}
        </>
      )}
    </section>
  )
}

function Summary({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="gap-1 p-4">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
    </Card>
  )
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
