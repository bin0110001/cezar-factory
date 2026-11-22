import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { getRunWorkflowView, getWorkflowOperatorActions, submitWorkflowOperatorAction, type WorkflowOperatorAction } from '@/api/client'
import { toast } from '@/components/ui/toaster'

export function WorkflowExecutionPanel({ runId, enabled, issueUrl, prUrl }: { runId: string; enabled: boolean; issueUrl?: string; prUrl?: string }) {
  const queryClient = useQueryClient()
  const [rationale, setRationale] = useState('')
  const query = useQuery({ queryKey: ['run-workflow-view', runId], queryFn: ({ signal }) => getRunWorkflowView(runId, { signal }), enabled })
  const actions = useQuery({ queryKey: ['run-workflow-actions', runId], queryFn: ({ signal }) => getWorkflowOperatorActions(runId, { signal }), enabled })
  const submitAction = useMutation({
    mutationFn: (action: WorkflowOperatorAction) => {
      if (!actions.data?.snapshot) throw new Error('Run snapshot unavailable; refresh before acting')
      return submitWorkflowOperatorAction(runId, { idempotencyKey: crypto.randomUUID(), action, expectedVersion: actions.data.snapshot, ...(action === 'escalate' ? { rationale } : {}) })
    },
    onSuccess: async (_result, action) => {
      setRationale('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['run-workflow-actions', runId] }),
        queryClient.invalidateQueries({ queryKey: ['run-workflow-view', runId] }),
      ])
      toast(`Workflow ${action} action recorded`)
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const view = query.data
  if (!view) return query.isError ? <p role="status" className="text-xs text-muted-foreground">Workflow execution view unavailable; run activity remains available in the thread.</p> : null
  const findingCounts = new Map<string, number>()
  for (const attempt of view.attempts) for (const finding of attempt.outputs?.findings ?? []) {
    const key = finding.fingerprint ?? finding.id
    if (key) findingCounts.set(key, (findingCounts.get(key) ?? 0) + 1)
  }
  return <section aria-label="Workflow execution" className="rounded-md border border-border bg-card p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold">Workflow execution</h2>
      <span className="text-xs text-muted-foreground">{view.workflow.id}@{view.workflow.version} · {view.status}</span>
    </div>
    {view.wait ? <p className="mt-2 text-xs">Waiting at <span className="font-mono">{view.wait.node}</span> for {view.wait.reason}; {view.wait.actor} can unblock it. {view.wait.detail ?? ''}{view.wait.resumeAt ? ` · resumes ${new Date(view.wait.resumeAt).toLocaleString()}` : ''}</p> : null}
    <p className="mt-2 text-xs text-muted-foreground">Attempt budget: {view.budget.usedAttempts}/{view.budget.maxAttempts} used · {view.budget.remainingAttempts} remaining</p>
    {view.stopReason ? <p className="mt-1 text-xs">Stopped at <span className="font-mono">{view.stopReason.node}</span>{view.stopReason.outcome ? ` with ${view.stopReason.outcome}` : ''}{view.stopReason.errorPresent ? ' · error recorded' : ''}</p> : null}
    <ul aria-label="Workflow node progress" className="mt-2 flex flex-wrap gap-1.5">{view.nodeProgress.map((node) => <li key={node.node} className={`rounded px-2 py-1 text-[11px] ${node.state === 'current' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}><span className="font-mono">{node.node}</span> · {node.state}{node.outcome ? ` · ${node.outcome}` : ''}</li>)}</ul>
    <ol aria-label="Workflow attempts" className="mt-2 space-y-1">
      {view.attempts.map((attempt, index) => <li key={`${attempt.node}:${attempt.attempt}:${index}`} className="flex flex-wrap items-center gap-x-2 text-xs">
        <span className="font-mono">{attempt.node}</span><span>attempt {attempt.attempt}</span><span className="text-muted-foreground">{attempt.outcome ?? attempt.status}</span>
        {attempt.outputs?.commitSha ? <code className="text-muted-foreground">{attempt.outputs.commitSha.slice(0, 12)}</code> : null}
        {attempt.outputs?.costUsd !== undefined ? <span className="text-muted-foreground">${attempt.outputs.costUsd.toFixed(4)}</span> : null}
        {attempt.outputs?.findings?.length || attempt.outputs?.coverage || attempt.outputs?.reviewLineage ? <details className="basis-full pl-3"><summary className="cursor-pointer">Review evidence · {attempt.outputs.findings?.length ?? 0} findings · revision {attempt.outputs.artifactRevision ?? 'unknown'}</summary>
          {attempt.outputs.coverage ? <p className="mt-1">Coverage: {attempt.outputs.coverage.coveredPaths.length} paths · excluded: {attempt.outputs.coverage.excludedPaths.join(', ') || 'none recorded'}</p> : null}
          {attempt.outputs.reviewLineage ? <p className="mt-1">Re-review of {attempt.outputs.reviewLineage.previousVerificationId ?? 'earlier review'}{attempt.outputs.reviewLineage.sameSessionRepair ? ' · repair reused the implementation session' : ''}</p> : null}
          <ul className="mt-1 space-y-1">{(attempt.outputs.findings ?? []).map((finding, findingIndex) => { const key = finding.fingerprint ?? finding.id; const repeats = key ? findingCounts.get(key) ?? 1 : 1; return <li key={key ?? findingIndex}>{finding.title ?? 'Finding'}{repeats > 1 ? ` · repeated ${repeats} times` : ''}{finding.path ? ` · ${finding.path}${finding.line ? `:${finding.line}` : ''}` : ''}{finding.provenance ? ` · ${finding.provenance}` : ''}{finding.verificationState ? ` · ${finding.verificationState}` : ''}{finding.confidence ? ` · confidence ${finding.confidence}` : ''}{finding.reviewerSessionId ? ` · reviewer ${finding.reviewerSessionId}` : ''}</li> })}</ul>
        </details> : null}
      </li>)}
    </ol>
    {view.children.length ? <p className="mt-2 text-xs text-muted-foreground">Child runs: {view.children.map((child) => `${child.id} (${child.dispatchKind ?? child.status})`).join(', ')}</p> : null}
    <p className="mt-2 text-[11px] text-muted-foreground">Factory workflow outcome: {view.status}. GitHub approval is separate and is not recorded in this workflow execution.</p>
    {query.isError ? <p role="status" className="mt-1 text-[11px] text-muted-foreground">Refresh unavailable; showing the last cached workflow view.</p> : null}
    {actions.data ? <div aria-label="Audited workflow actions" className="mt-3 border-t pt-3">
      <p className="text-xs font-medium">Operator controls · actions are recorded to this project</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(['resume', 'reconcile', 'cancel', 'approve'] as const).map((action) => <button key={action} type="button" className="rounded border px-2 py-1 text-xs disabled:opacity-50" disabled={submitAction.isPending || !actions.data.snapshot || (action === 'approve' && view.wait?.reason !== 'human') || (action === 'resume' && view.wait?.reason !== 'human')} onClick={() => submitAction.mutate(action)}>{action[0]!.toUpperCase() + action.slice(1)}</button>)}
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); submitAction.mutate('escalate') }}>
          <label className="sr-only" htmlFor={`workflow-escalation-${runId}`}>Escalation rationale</label>
          <input id={`workflow-escalation-${runId}`} className="min-w-40 rounded border bg-background px-2 py-1 text-xs" maxLength={2000} required value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Escalation rationale" />
          <button type="submit" className="rounded border px-2 py-1 text-xs disabled:opacity-50" disabled={submitAction.isPending || !actions.data.snapshot}>Escalate</button>
        </form>
      </div>
      <ol aria-label="Workflow action audit" className="mt-2 space-y-1 text-[11px] text-muted-foreground">{actions.data.actions.slice(-5).reverse().map((action) => <li key={`${action.idempotencyKey}:${action.phase}`}>{action.action} · {action.phase} · {action.actor} · {new Date(action.at).toLocaleString()}{action.result ? ` · ${action.result}` : ''}{action.rationale ? ` · ${action.rationale}` : ''}</li>)}</ol>
    </div> : actions.isError ? <p role="status" className="mt-2 text-[11px] text-muted-foreground">Operator controls unavailable; run remains readable.</p> : null}
    {issueUrl || prUrl ? <nav aria-label="Workflow context" className="mt-2 flex gap-3 text-xs">{issueUrl ? <a href={issueUrl} target="_blank" rel="noreferrer" className="underline">Backlog issue</a> : null}{prUrl ? <a href={prUrl} target="_blank" rel="noreferrer" className="underline">Pull request</a> : null}</nav> : null}
  </section>
}
