import { useQuery } from '@tanstack/react-query'

import { getRunWorkflowView } from '@/api/client'

export function WorkflowExecutionPanel({ runId, enabled }: { runId: string; enabled: boolean }) {
  const query = useQuery({ queryKey: ['run-workflow-view', runId], queryFn: ({ signal }) => getRunWorkflowView(runId, { signal }), enabled })
  const view = query.data
  if (!view) return null
  return <section aria-label="Workflow execution" className="rounded-md border border-border bg-card p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold">Workflow execution</h2>
      <span className="text-xs text-muted-foreground">{view.workflow.id}@{view.workflow.version} · {view.status}</span>
    </div>
    {view.wait ? <p className="mt-2 text-xs">Waiting for {view.wait.reason}: {view.wait.detail ?? view.wait.node}</p> : null}
    <ol aria-label="Workflow attempts" className="mt-2 space-y-1">
      {view.attempts.map((attempt, index) => <li key={`${attempt.node}:${attempt.attempt}:${index}`} className="flex flex-wrap items-center gap-x-2 text-xs">
        <span className="font-mono">{attempt.node}</span><span>attempt {attempt.attempt}</span><span className="text-muted-foreground">{attempt.outcome ?? attempt.status}</span>
        {attempt.outputs?.commitSha ? <code className="text-muted-foreground">{attempt.outputs.commitSha.slice(0, 12)}</code> : null}
        {attempt.outputs?.findings?.length ? <span>{attempt.outputs.findings.length} findings at {attempt.outputs.findings[0]?.path ?? 'unknown path'}</span> : null}
      </li>)}
    </ol>
    {view.children.length ? <p className="mt-2 text-xs text-muted-foreground">Child runs: {view.children.map((child) => `${child.id} (${child.dispatchKind ?? child.status})`).join(', ')}</p> : null}
    <p className="mt-2 text-[11px] text-muted-foreground">GitHub approval is tracked separately from workflow outcomes.</p>
  </section>
}
