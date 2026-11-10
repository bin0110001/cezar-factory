import { AlertTriangleIcon, ChevronDownIcon, ExternalLinkIcon, HistoryIcon } from 'lucide-react'

import { codingRunEvidenceUrl } from '@/api/client'
import { useCodingRunExplorer } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { isHttpUrl } from '@/lib/utils'

const statusLabel: Record<string, string> = {
  running: 'Running', waiting: 'Waiting', blocked: 'Blocked', unknown: 'Unknown',
  untested: 'Untested', flaky: 'Flaky', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled',
}

function observed<T extends { availability: string; value?: unknown; reason?: string; reasonCode?: string }>(value: T): string {
  if (value.availability === 'available') {
    const observedValue = value.value
    if (observedValue && typeof observedValue === 'object') return Object.values(observedValue).filter((item) => typeof item === 'string').join(' · ')
    return typeof observedValue === 'string' ? observedValue : 'Available'
  }
  if (value.availability === 'unavailable') return `Unavailable (${value.reasonCode ?? 'unknown reason'})`
  return 'Unknown'
}

export function IssueRunExplorer({ issueNumber, issueBlocked = false }: { issueNumber: number; issueBlocked?: boolean }) {
  const query = useCodingRunExplorer(issueNumber)
  const runs = query.data?.pages.flatMap((page) => page.runs) ?? []
  const unavailable = query.isError

  return (
    <section aria-labelledby="issue-run-explorer-title" className="my-4 rounded-lg border border-border bg-muted/20">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <HistoryIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 id="issue-run-explorer-title" className="text-sm font-semibold">Issue run history</h2>
        <span className="text-xs text-muted-foreground">#{issueNumber}</span>
        <nav aria-label="Related evidence views" className="ml-auto flex gap-3 text-xs">
          <Link className="text-violet underline underline-offset-2" to="/verification">Verification history</Link>
          <Link className="text-violet underline underline-offset-2" to="/dependencies">Dependency graph</Link>
          <span className="text-muted-foreground" title="The release control read model is still being implemented in issue #70">Release details unavailable</span>
        </nav>
      </div>
      {issueBlocked ? <p role="status" className="border-b border-border bg-warning/10 px-3 py-2 text-xs"><strong>Blocked:</strong> this issue has the `factory:blocked` label. Check its latest GitHub comments for the recorded dependency or action.</p> : null}
      {query.isPending ? <p className="px-3 py-4 text-sm text-muted-foreground">Loading run history…</p> : null}
      {unavailable ? <p role="status" className="px-3 py-4 text-sm text-muted-foreground"><AlertTriangleIcon aria-hidden="true" className="mr-1.5 inline size-4" />Run history is unavailable. This issue may not have ledger records yet.</p> : null}
      {!query.isPending && !unavailable && runs.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">Run history is unknown: no coding-run ledger records are available for this issue yet.</p> : null}
      {runs.length ? (
        <ol aria-label="Coding runs" className="divide-y divide-border">
          {runs.map((run) => (
            <li key={run.runId} className="px-3 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-mono font-medium">{run.runId}</span>
                <span className="rounded border border-border px-1.5 py-0.5" aria-label={`Status: ${statusLabel[run.status]}`}>{statusLabel[run.status]}</span>
                <span className="text-muted-foreground">{run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Start time unknown'}</span>
                {run.trace.availability === 'available' ? <a className="ml-auto inline-flex items-center gap-1 text-violet underline underline-offset-2" href={run.trace.url} target="_blank" rel="noreferrer" title="Langfuse enforces access to this project">Open Langfuse trace (project access required)<ExternalLinkIcon aria-hidden="true" className="size-3" /></a> : <span className="ml-auto text-muted-foreground" title={run.trace.reason}>Trace unavailable</span>}
              </div>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="inline font-medium text-foreground">Worker: </dt><dd className="inline">{observed(run.worker)}</dd></div>
                <div><dt className="inline font-medium text-foreground">Agent: </dt><dd className="inline">{observed(run.agent)}</dd></div>
                <div><dt className="inline font-medium text-foreground">Model: </dt><dd className="inline">{observed(run.model)}</dd></div>
                <div><dt className="inline font-medium text-foreground">Evidence: </dt><dd className="inline">{run.evidenceComplete ? 'Complete' : `${run.evidenceCount} reference${run.evidenceCount === 1 ? '' : 's'}; completeness unknown`}</dd></div>
              </dl>
              {run.pullRequest.availability === 'available' ? <p className="mt-1 text-xs text-muted-foreground">{run.pullRequest.value.url && isHttpUrl(run.pullRequest.value.url) ? <a className="text-violet underline underline-offset-2" href={run.pullRequest.value.url} target="_blank" rel="noreferrer">PR #{run.pullRequest.value.number}</a> : `PR #${run.pullRequest.value.number}`}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">Validation: {run.validationCount === 0 ? 'Untested' : `${run.validationCount} recorded validation${run.validationCount === 1 ? '' : 's'}${run.latestValidationAt ? ` · latest ${new Date(run.latestValidationAt).toLocaleString()}` : ''}`}</p>
              {run.commits.length ? <p className="mt-1 text-xs text-muted-foreground">Commits: <span className="font-mono">{run.commits.join(', ')}</span></p> : null}
              {run.attempts.length ? <ol aria-label={`Attempts for ${run.runId}`} className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">{run.attempts.map((attempt) => <li key={attempt.attemptId}>Attempt {attempt.index}: {attempt.status}{attempt.supersedesAttemptId ? ` · retry after ${attempt.supersedesAttemptId}` : ''}</li>)}</ol> : null}
              {run.timeline.length ? <ol aria-label={`Timeline for ${run.runId}`} className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">{run.timeline.map((event) => <li key={event.eventId}><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString()}</time> · {event.type.replaceAll('.', ' ')}</li>)}</ol> : null}
              {run.timelineTruncated ? <p className="mt-1 text-[11px] text-muted-foreground">Showing the latest 100 of {run.eventCount} events.</p> : null}
              {run.evidence.length ? <ul aria-label={`Evidence for ${run.runId}`} className="mt-2 flex flex-wrap gap-2 text-xs">{run.evidence.map((evidence) => <li key={evidence.evidenceId}>{evidence.downloadUrl && evidence.sha256 && evidence.availability === 'available' ? <a className="text-violet underline underline-offset-2" href={codingRunEvidenceUrl(issueNumber, run.runId, evidence.sha256)} download>{evidence.kind} · {evidence.evidenceId}</a> : <span className="text-muted-foreground">{evidence.kind} · {evidence.evidenceId} ({evidence.availability})</span>}</li>)}</ul> : null}
              {run.integrity !== 'valid' ? <p role="status" className="mt-2 text-xs text-warning">Ledger record integrity: {run.integrity}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {query.hasNextPage ? <div className="border-t border-border p-2"><Button variant="ghost" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'Load older runs'}<ChevronDownIcon aria-hidden="true" className="size-3.5" /></Button></div> : null}
    </section>
  )
}
