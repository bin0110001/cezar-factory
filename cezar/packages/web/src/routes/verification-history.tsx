import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircleIcon, ChevronDownIcon, ChevronRightIcon, FileTextIcon, RefreshCwIcon } from 'lucide-react'
import type { VerificationQueryResponse } from '@open-mercato/cezar-api-client'
import { getVerificationArtifact, queryReliabilityAnalytics, queryVerificationHistory } from '@/api/client'
import { Button } from '@/components/ui/button'

const HISTORY_PAGE_SIZE = 25
const historyKey = ['verification-history'] as const

type RunsPage = Extract<VerificationQueryResponse, { kind: 'runs' }>
type ArtifactsPage = Extract<VerificationQueryResponse, { kind: 'artifacts' }>
type FailuresPage = Extract<VerificationQueryResponse, { kind: 'failures' }>
type DetailItems = {
  selected: Extract<VerificationQueryResponse, { kind: 'selected' }>['items']
  deferred: Extract<VerificationQueryResponse, { kind: 'deferred' }>['items']
  failures: FailuresPage['items']
  episodes: Extract<VerificationQueryResponse, { kind: 'episodes' }>['items']
  artifacts: ArtifactsPage['items']
}

function when(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function boundedText(value: { content: string | null; head: string | null; tail: string | null }): string {
  if (value.content !== null) return value.content
  return [value.head, value.tail].filter(Boolean).join('\n…\n')
}

async function queryAllRunItems<K extends keyof DetailItems>(
  kind: K,
  runId: string,
  signal: AbortSignal,
): Promise<DetailItems[K]> {
  const result: unknown[] = []
  let cursor: string | undefined
  do {
    const page = await queryVerificationHistory({ kind, runId, pageSize: 100, ...(cursor ? { cursor } : {}) }, { signal })
    if (page.kind !== kind) throw new Error(`Expected ${kind} verification history, received ${page.kind}.`)
    result.push(...page.items)
    if (page.page.hasMore && !page.page.nextCursor) throw new Error(`The ${kind} verification history page has no continuation cursor.`)
    cursor = page.page.hasMore ? page.page.nextCursor! : undefined
  } while (cursor)
  return result as DetailItems[K]
}

function groupFailures(failures: FailuresPage['items']) {
  const groups = new Map<string, FailuresPage['items']>()
  for (const failure of failures) {
    const key = failure.episodeId ?? `unknown:${failure.testId}`
    groups.set(key, [...(groups.get(key) ?? []), failure])
  }
  return [...groups.entries()].map(([id, items]) => ({
    id,
    episodeId: items[0]?.episodeId,
    classification: items.some((item) => item.classification === 'known') ? 'known'
      : items.some((item) => item.classification === 'new') ? 'new' : 'unknown',
    items,
  }))
}

function statusColor(status: string): string {
  if (status === 'passed') return 'text-emerald-700 dark:text-emerald-400'
  if (status === 'failed' || status === 'infrastructure-error') return 'text-destructive'
  return 'text-muted-foreground'
}

function ArtifactEvidence({ verificationId, artifact }: {
  verificationId: string
  artifact: ArtifactsPage['items'][number]
}) {
  const [open, setOpen] = useState(false)
  const content = useQuery({
    queryKey: [...historyKey, verificationId, 'artifact', artifact.id],
    queryFn: ({ signal }) => getVerificationArtifact(verificationId, artifact.id, { signal }),
    enabled: open && artifact.data.reference.startsWith(`run:${verificationId}/artifacts/`),
    staleTime: Infinity,
  })
  return (
    <li className="rounded-md border p-3" data-testid={`verification-artifact-${artifact.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all text-sm font-medium">{artifact.name}</p>
          <p className="break-all font-mono text-xs text-muted-foreground">{artifact.path} · {artifact.data.bytes.toLocaleString()} bytes</p>
        </div>
        <Button size="sm" variant="outline" disabled={!artifact.data.reference || open && content.isPending} onClick={() => setOpen((value) => !value)}>
          <FileTextIcon className="size-4" /> {open ? 'Hide evidence' : 'Load evidence'}
        </Button>
      </div>
      {!open && artifact.data.truncated && <p className="mt-2 text-xs text-muted-foreground">Large evidence is fetched only when opened.</p>}
      {!artifact.data.truncated && artifact.data.content !== null && <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-3 text-xs">{artifact.data.content}</pre>}
      {open && content.isPending && <p className="mt-3 text-sm text-muted-foreground" role="status">Loading evidence…</p>}
      {open && content.isError && <p className="mt-3 text-sm text-destructive" role="alert">Evidence unavailable: {content.error.message}</p>}
      {open && content.data && <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-3 text-xs">{content.data.content}{content.data.truncated ? '\n… evidence preview truncated …' : ''}</pre>}
    </li>
  )
}

export function VerificationHistoryRoute() {
  const [status, setStatus] = useState('')
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(30)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [pageIndex, setPageIndex] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [trendCheckId, setTrendCheckId] = useState<string | null>(null)
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null)
  const cursor = cursors[pageIndex]
  const page = useQuery({
    queryKey: [...historyKey, 'runs', status, cursor],
    queryFn: ({ signal }) => queryVerificationHistory({ kind: 'runs', pageSize: HISTORY_PAGE_SIZE, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }, { signal }),
    staleTime: 15_000,
  })
  const analytics = useQuery({
    queryKey: [...historyKey, 'reliability', windowDays],
    queryFn: () => queryReliabilityAnalytics(windowDays),
    staleTime: 30_000,
  })
  const runPage = page.data?.kind === 'runs' ? page.data as RunsPage : undefined
  const run = runPage?.items.find((item) => item.id === selectedRunId)
  const detailQueries = useQuery({
    queryKey: [...historyKey, 'detail', selectedRunId],
    enabled: Boolean(selectedRunId),
    queryFn: async ({ signal }) => {
      const [selected, deferred, failures, episodes, artifacts] = await Promise.all([
        queryAllRunItems('selected', selectedRunId!, signal),
        queryAllRunItems('deferred', selectedRunId!, signal),
        queryAllRunItems('failures', selectedRunId!, signal),
        queryAllRunItems('episodes', selectedRunId!, signal),
        queryAllRunItems('artifacts', selectedRunId!, signal),
      ])
      return { selected, deferred, failures, episodes, artifacts }
    },
  })

  const changeStatus = (next: string) => {
    setStatus(next)
    setCursors([undefined])
    setPageIndex(0)
    setSelectedRunId(null)
    setTrendCheckId(null)
    setSelectedTestId(null)
  }
  const nextPage = () => {
    if (!runPage?.page.nextCursor) return
    const next = [...cursors.slice(0, pageIndex + 1), runPage.page.nextCursor]
    setCursors(next)
    setPageIndex(next.length - 1)
    setSelectedRunId(null)
    setSelectedTestId(null)
  }
  const previousPage = () => { setPageIndex((index) => Math.max(0, index - 1)); setSelectedRunId(null); setSelectedTestId(null) }

  return (
    <main className="flex flex-col gap-4 p-4" data-testid="verification-history-route">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Verification history</h1>
          <p className="text-sm text-muted-foreground">Read-only runs, failure recurrence, selection reasons and check performance.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="verification-status-filter">Filter by status</label>
          <select id="verification-status-filter" aria-label="Filter by status" className="min-h-9 rounded-md border bg-background px-2 text-sm" value={status} onChange={(event) => changeStatus(event.target.value)}>
            <option value="">All statuses</option>
            {['passed', 'failed', 'skipped', 'unknown', 'infrastructure-error', 'cancelled'].map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
          <Button variant="outline" size="sm" onClick={() => void page.refetch()} disabled={page.isFetching}><RefreshCwIcon className="size-4" /> Refresh</Button>
        </div>
      </header>

      <section className="rounded-lg border p-4" aria-labelledby="reliability-analytics-heading" data-testid="reliability-analytics">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 id="reliability-analytics-heading" className="font-semibold">Reliability analytics</h2><p className="text-xs text-muted-foreground">Evidence-backed validation, repair, failure and pull request outcomes for this project.</p></div>
          <label className="flex items-center gap-2 text-sm">Window
            <select aria-label="Reliability analytics window" className="min-h-9 rounded-md border bg-background px-2" value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value) as 7 | 30 | 90)}>
              <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
            </select>
          </label>
        </div>
        {analytics.isPending && <p className="mt-3 text-sm text-muted-foreground" role="status">Loading reliability metrics…</p>}
        {analytics.isError && <p className="mt-3 text-sm text-destructive" role="alert">Reliability metrics are unavailable: {analytics.error.message}</p>}
        {analytics.data && <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-md bg-muted/30 p-3"><p className="text-xs text-muted-foreground">First pass validation</p><p className="mt-1 text-lg font-semibold">{analytics.data.summary.firstPass.rate === null ? 'No data' : `${Math.round(analytics.data.summary.firstPass.rate * 100)}%`}</p><p className="text-xs">{analytics.data.summary.firstPass.successful} / {analytics.data.summary.firstPass.eligible} work items</p></div>
            <div className="rounded-md bg-muted/30 p-3"><p className="text-xs text-muted-foreground">Bounded repair success</p><p className="mt-1 text-lg font-semibold">{analytics.data.summary.boundedRepairs.rate === null ? 'No data' : `${Math.round(analytics.data.summary.boundedRepairs.rate * 100)}%`}</p><p className="text-xs">{analytics.data.summary.boundedRepairs.successful} / {analytics.data.summary.boundedRepairs.eligible} repair attempts</p></div>
            <div className="rounded-md bg-muted/30 p-3"><p className="text-xs text-muted-foreground">Failure classification</p><p className="mt-1 text-sm">{analytics.data.summary.failures.regression} regression · {analytics.data.summary.failures.flaky} flaky</p><p className="text-xs">{analytics.data.summary.failures.infrastructure} infrastructure · {analytics.data.summary.failures.unknown} unknown</p></div>
            <div className="rounded-md bg-muted/30 p-3"><p className="text-xs text-muted-foreground">Pull request outcomes</p><p className="mt-1 text-sm">{analytics.data.summary.pullRequests.merged} merged · {analytics.data.summary.pullRequests.rejected} closed unmerged</p><p className="text-xs">{analytics.data.summary.pullRequests.reverted} reverted · {analytics.data.summary.pullRequests.pending} open · {analytics.data.summary.pullRequests.unknown} unknown</p></div>
            <div className="rounded-md bg-muted/30 p-3"><p className="text-xs text-muted-foreground">Time to accepted PR</p><p className="mt-1 text-lg font-semibold">{analytics.data.summary.pullRequests.medianTimeToAcceptedMs === null ? 'No data' : `${(analytics.data.summary.pullRequests.medianTimeToAcceptedMs / 3_600_000).toFixed(1)} h`}</p><p className="text-xs">Median · {analytics.data.summary.pullRequests.acceptedDurationCount} linked merge{analytics.data.summary.pullRequests.acceptedDurationCount === 1 ? '' : 's'}</p></div>
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <section aria-labelledby="reliability-trend-heading">
              <h3 id="reliability-trend-heading" className="text-sm font-semibold">Daily trend</h3>
              <div className="mt-2 overflow-x-auto rounded border">
                <table className="w-full text-left text-xs"><thead className="bg-muted/30"><tr><th scope="col" className="p-2">Date</th><th scope="col" className="p-2">Runs</th><th scope="col" className="p-2">First pass</th><th scope="col" className="p-2">Repair</th><th scope="col" className="p-2">Failures</th><th scope="col" className="p-2">Merged</th><th scope="col" className="p-2">Closed</th><th scope="col" className="p-2">Reverted</th></tr></thead>
                  <tbody>{analytics.data.trends.filter((row) => row.validationRuns || row.merged || row.rejected || row.reverted || Object.values(row.failures).some(Boolean)).map((row) => <tr key={row.date} className="border-t"><th scope="row" className="p-2 font-normal">{row.date}</th><td className="p-2">{row.validationRuns}</td><td className="p-2">{row.firstPassSuccessful}</td><td className="p-2">{row.repairsSuccessful}</td><td className="p-2">{row.failures.infrastructure + row.failures.flaky + row.failures.regression + row.failures.unknown}</td><td className="p-2">{row.merged}</td><td className="p-2">{row.rejected}</td><td className="p-2">{row.reverted}</td></tr>)}</tbody>
                </table>
                {analytics.data.trends.every((row) => row.validationRuns === 0 && row.merged === 0 && row.rejected === 0 && row.reverted === 0) && <p className="p-3 text-xs text-muted-foreground">No recorded activity in this window.</p>}
              </div>
            </section>
            <section aria-labelledby="reliability-segments-heading">
              <h3 id="reliability-segments-heading" className="text-sm font-semibold">Project and model segments</h3>
              <div className="mt-2 overflow-x-auto rounded border"><table className="w-full text-left text-xs"><thead className="bg-muted/30"><tr><th scope="col" className="p-2">Project / model</th><th scope="col" className="p-2">Runs</th><th scope="col" className="p-2">First pass</th><th scope="col" className="p-2">Repair</th><th scope="col" className="p-2">PRs M / C / R</th></tr></thead><tbody>{analytics.data.segments.map((segment) => <tr key={`${segment.projectId}:${segment.model}`} className="border-t"><th scope="row" className="p-2 font-normal"><span className="block">{segment.projectId}</span><span className="text-muted-foreground">{segment.model}</span></th><td className="p-2">{segment.validationRuns}</td><td className="p-2">{segment.firstPass.rate === null ? '—' : `${Math.round(segment.firstPass.rate * 100)}%`}</td><td className="p-2">{segment.boundedRepairs.rate === null ? '—' : `${Math.round(segment.boundedRepairs.rate * 100)}%`}</td><td className="p-2">{segment.pullRequests.merged} / {segment.pullRequests.rejected} / {segment.pullRequests.reverted}</td></tr>)}</tbody></table></div>
            </section>
          </div>
          {(analytics.data.coverage.missingBaselineSha > 0 || !analytics.data.coverage.pullRequestStatusesAvailable || analytics.data.coverage.truncated || analytics.data.coverage.timelineTruncated) && <p className="mt-3 rounded border border-amber-500/40 p-2 text-xs" role="note">Coverage limits: {analytics.data.coverage.missingBaselineSha} failures have no baseline SHA; {analytics.data.coverage.pullRequestReferences} pull request references observed; {analytics.data.coverage.truncated ? 'PR status list capped at 50. ' : ''}{analytics.data.coverage.timelineTruncated ? 'Only eight terminal PR timelines were checked. ' : ''}{!analytics.data.coverage.pullRequestStatusesAvailable ? analytics.data.coverage.pullRequestStatusReason ?? 'GitHub status is unavailable.' : ''}</p>}
          <p className="mt-2 text-xs text-muted-foreground">{analytics.data.coverage.linkedCodingRuns} of {analytics.data.coverage.validationEvents} verification runs link to coding-run metadata · {analytics.data.coverage.unreadableValidationEvents} validation events could not be parsed · finding-ledger retention {analytics.data.coverage.retentionDays} days · generated {when(analytics.data.generatedAt)}</p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">Recurring failure drilldown ({analytics.data.drilldowns.length})</summary>
            {analytics.data.drilldowns.length > 0 ? <ul className="mt-2 space-y-2">{analytics.data.drilldowns.map((item) => <li className="rounded border p-3 text-xs" key={item.fingerprint}><p><span className="font-mono">{item.fingerprint.slice(0, 16)}</span> · {item.classification} · {item.occurrences} occurrence{item.occurrences === 1 ? '' : 's'}</p><p className="mt-1 text-muted-foreground">Issues {item.issueNumbers.length ? item.issueNumbers.map((number) => `#${number}`).join(', ') : 'unknown'} · source {item.sourceShas[0]?.slice(0, 12) ?? 'unknown'} · baseline {item.baselineShas[0]?.slice(0, 12) ?? 'not recorded'} · evidence IDs {item.evidenceIds.length ? item.evidenceIds.join(', ') : 'not recorded'}</p></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No fingerprinted failures in this window.</p>}
          </details>
        </>}
      </section>

      {page.isPending && <p className="rounded-md border p-5 text-sm text-muted-foreground" role="status">Loading verification history…</p>}
      {page.isError && <section className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert"><AlertCircleIcon className="mr-2 inline size-4" />Verification history is unavailable: {page.error.message}</section>}
      {runPage && runPage.items.length === 0 && <section className="rounded-md border p-8 text-center"><h2 className="font-medium">No verification runs yet</h2><p className="mt-1 text-sm text-muted-foreground">Runs appear here after a workflow executes a verification suite.</p></section>}

      {runPage && runPage.items.length > 0 && <section className="overflow-hidden rounded-lg border" aria-label="Verification runs">
        <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(6rem,.8fr)_minmax(8rem,1fr)_minmax(7rem,.8fr)] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
          <span>Run</span><span>Status</span><span>Selection / failures</span><span>Started</span>
        </div>
        <ol>
          {runPage.items.map((item) => {
            const expanded = item.id === selectedRunId
            return <li key={item.id} className="border-b last:border-0">
              <button className="grid w-full grid-cols-[minmax(0,1.6fr)_minmax(6rem,.8fr)_minmax(8rem,1fr)_minmax(7rem,.8fr)] items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/30" aria-expanded={expanded} aria-controls={`verification-run-detail-${encodeURIComponent(item.id)}`} onClick={() => { setSelectedRunId(expanded ? null : item.id); setTrendCheckId(null); setSelectedTestId(null) }}>
                <span className="flex min-w-0 items-center gap-2">{expanded ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}<span className="min-w-0"><span className="block truncate font-medium">{item.id}</span><span className="block truncate font-mono text-xs text-muted-foreground">{item.commitSha.slice(0, 10)} · {item.checks?.length ?? 0} checks</span></span></span>
                <span className={statusColor(item.status)}>{item.status}</span>
                <span className="text-xs text-muted-foreground">{item.counts.selected} selected · {item.counts.deferred} deferred · {item.counts.failures} failed</span>
                <time className="text-xs text-muted-foreground">{when(item.startedAt)}</time>
              </button>
              {expanded && <div id={`verification-run-detail-${encodeURIComponent(item.id)}`} className="border-t bg-muted/10 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div><p className="font-medium">Suite: {item.suite ?? 'verification'}</p><p className="text-xs text-muted-foreground">Finished {when(item.finishedAt)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Commit {item.commitSha.slice(0, 12)} · base {item.baseSha ? item.baseSha.slice(0, 12) : 'not recorded'}</p>
                    <nav className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={`Links for verification run ${item.id}`}>
                      {item.cezarRunId && <a className="text-primary underline underline-offset-2" href={`/p/${encodeURIComponent(item.projectId ?? '')}/tasks/${encodeURIComponent(item.cezarRunId)}`}>Open Cezar agent work</a>}
                      {item.githubIssueUrl && <a className="text-primary underline underline-offset-2" href={item.githubIssueUrl} target="_blank" rel="noreferrer">Open linked GitHub issue</a>}
                    </nav>
                  </div>
                  {detailQueries.isFetching && <span className="text-xs text-muted-foreground" role="status">Loading run evidence…</span>}
                </div>
                {detailQueries.isError && <p className="mt-3 text-sm text-destructive" role="alert">Run details could not be loaded: {detailQueries.error.message}</p>}
                {detailQueries.data && <div className="mt-4 grid gap-5 xl:grid-cols-2">
                  <section>
                    <h2 className="text-sm font-semibold">Selected checks</h2>
                    <ul className="mt-2 space-y-2 text-sm">{detailQueries.data.selected.map((entry) => <li key={entry.testId} className="rounded border p-2"><button className="font-mono text-left underline underline-offset-2" aria-expanded={selectedTestId === entry.testId} aria-controls={`test-detail-${encodeURIComponent(entry.testId)}`} onClick={() => setSelectedTestId((current) => current === entry.testId ? null : entry.testId)}>{entry.testId}</button><p className="mt-1 text-xs text-muted-foreground">{boundedText(entry.reason)}</p>{selectedTestId === entry.testId && <div id={`test-detail-${encodeURIComponent(entry.testId)}`} className="mt-2 rounded bg-muted/30 p-2 text-xs"><p>Coverage: {(item.checks ?? []).find((check) => check.checkId === entry.testId)?.status ?? 'not reported by this run'}</p><a className="mt-1 inline-block text-primary underline underline-offset-2" href={`?runId=${encodeURIComponent(item.id)}&testId=${encodeURIComponent(entry.testId)}`}>Stable link to this check</a></div>}</li>)}</ul>
                    {detailQueries.data.selected.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No selection details were recorded.</p>}
                    <h2 className="mt-4 text-sm font-semibold">Deferred checks</h2>
                    <ul className="mt-2 space-y-2 text-sm">{detailQueries.data.deferred.map((entry) => <li key={entry.testId} className="rounded border p-2"><button className="font-mono text-left underline underline-offset-2" aria-expanded={selectedTestId === entry.testId} aria-controls={`test-detail-${encodeURIComponent(entry.testId)}`} onClick={() => setSelectedTestId((current) => current === entry.testId ? null : entry.testId)}>{entry.testId}</button><p className="mt-1 text-xs text-muted-foreground">{boundedText(entry.reason)}</p>{selectedTestId === entry.testId && <div id={`test-detail-${encodeURIComponent(entry.testId)}`} className="mt-2 rounded bg-muted/30 p-2 text-xs"><p>Coverage limitation: this check was deferred, so this run has no result for it.</p><a className="mt-1 inline-block text-primary underline underline-offset-2" href={`?runId=${encodeURIComponent(item.id)}&testId=${encodeURIComponent(entry.testId)}`}>Stable link to this check</a></div>}</li>)}</ul>
                    {detailQueries.data.deferred.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No checks were deferred.</p>}
                    <h2 className="mt-4 text-sm font-semibold">Run coverage and environment</h2>
                    {item.coverage ? <p className="mt-1 text-xs text-muted-foreground">{item.coverage.passed} passed · {item.coverage.failed} failed · {item.coverage.skipped} skipped · {item.coverage.unknown} unknown of {item.coverage.selected} selected</p> : <p className="mt-1 text-xs text-muted-foreground">Coverage totals were not recorded for this run.</p>}
                    {item.baselineRunId ? <p className="mt-1 text-xs">Baseline run: <a className="text-primary underline" href={`?runId=${encodeURIComponent(item.baselineRunId)}`}>{item.baselineRunId}</a></p> : <p className="mt-1 text-xs text-muted-foreground">No baseline run was recorded; comparisons are unavailable.</p>}
                    {item.environment && Object.keys(item.environment).length > 0 ? <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">{Object.entries(item.environment).map(([key, value]) => <div className="contents" key={key}><dt className="font-medium">{key}</dt><dd className="break-all text-muted-foreground">{value}</dd></div>)}</dl> : <p className="mt-1 text-xs text-muted-foreground">Environment details were not recorded.</p>}
                  </section>

                  <section>
                    <h2 className="text-sm font-semibold">Failures and recurrence</h2>
                    <ul className="mt-2 space-y-2">{groupFailures(detailQueries.data.failures).map((group) => <li key={group.id} className="rounded border p-3 text-sm" data-testid={`verification-failure-group-${group.id}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono">{group.episodeId ? `Finding ${group.episodeId.slice(0, 12)}` : group.items[0]?.testId}</span><span className={group.classification === 'known' ? 'text-amber-700 dark:text-amber-400' : group.classification === 'new' ? 'text-destructive' : 'text-muted-foreground'}>{group.classification}</span></div>
                      <p className="mt-1 text-xs text-muted-foreground">{group.items.length} failure{group.items.length === 1 ? '' : 's'}</p>
                      {group.episodeId && <a className="mt-2 inline-block text-xs text-primary underline underline-offset-2" href={`#verification-episode-${group.episodeId}`}>View recurrence episode</a>}
                      <a className="ml-3 inline-block text-xs text-primary underline underline-offset-2" href="#verification-artifacts">View run evidence</a>
                      <ul className="mt-2 space-y-2">{group.items.map((failure) => <li key={failure.id} className="rounded bg-muted/20 p-2">
                        <p className="font-mono">{failure.testId}</p><p className="mt-1 whitespace-pre-wrap">{boundedText(failure.message)}</p>
                        {failure.output.content !== null && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs">{failure.output.content}</pre>}
                        {failure.output.content === null && <p className="mt-2 text-xs text-muted-foreground">Output is large; reference {failure.output.reference}</p>}
                      </li>)}</ul>
                    </li>)}</ul>
                    {detailQueries.data.failures.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No failing checks in this run.</p>}
                    <h3 className="mt-4 text-sm font-semibold">Episodes</h3>
                    <ul className="mt-2 space-y-1 text-xs">{detailQueries.data.episodes.map((episode) => <li id={`verification-episode-${episode.id}`} key={episode.id} className="rounded border p-2"><span className="font-mono">{episode.fingerprint.slice(0, 12)}</span> · {episode.status} · {episode.occurrences} occurrence{episode.occurrences === 1 ? '' : 's'} · {when(episode.firstSeenAt)} to {when(episode.lastSeenAt)}</li>)}</ul>
                    {detailQueries.data.episodes.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No recurrence episodes recorded for this run.</p>}
                  </section>

                  <section>
                    <h2 className="text-sm font-semibold">Check performance</h2>
                    <div className="mt-2 space-y-2">{(item.checks ?? []).map((check) => <button key={check.checkId} onClick={() => setTrendCheckId(check.checkId)} className={`w-full rounded border p-2 text-left ${trendCheckId === check.checkId ? 'border-primary bg-primary/5' : ''}`} aria-pressed={trendCheckId === check.checkId}>
                      <div className="flex justify-between gap-3 text-xs"><span className="font-mono">{check.checkId}</span><span>{check.durationMs.toLocaleString()} ms</span></div>
                      {check.metrics.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{check.metrics.map((metric) => `${metric.name}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`).join(' · ')}</p>}
                    </button>)}</div>
                    {trendCheckId && <div className="mt-3 rounded-md border p-3" role="img" aria-label={`Duration trend for ${trendCheckId}`} data-testid="verification-trend">
                      <h3 className="text-xs font-medium">Recent duration trend · {trendCheckId}</h3>
                      <ol className="mt-2 space-y-2">{runPage.items.flatMap((runItem) => (runItem.checks ?? []).filter((check) => check.checkId === trendCheckId).map((check) => ({ runItem, check }))).reverse().map(({ runItem, check }) => {
                        const max = Math.max(1, ...runPage.items.flatMap((runItem) => (runItem.checks ?? []).filter((candidate) => candidate.checkId === trendCheckId).map((candidate) => candidate.durationMs)))
                        return <li key={runItem.id} className="grid grid-cols-[7rem_1fr_5rem] items-center gap-2 text-xs"><time>{when(runItem.startedAt)}</time><span className="h-2 rounded bg-muted"><span className="block h-2 rounded bg-primary" style={{ width: `${Math.max(2, check.durationMs / max * 100)}%` }} /></span><span className="text-right">{check.durationMs} ms</span></li>
                      })}</ol>
                      {runPage.items.every((runItem) => !(runItem.checks ?? []).some((check) => check.checkId === trendCheckId)) && <p className="mt-2 text-xs text-muted-foreground">No trend points are available on this page.</p>}
                    </div>}
                  </section>

                  <section id="verification-artifacts">
                    <h2 className="text-sm font-semibold">Artifacts</h2>
                    <ul className="mt-2 space-y-2">{detailQueries.data.artifacts.map((artifact) => <ArtifactEvidence key={artifact.id} verificationId={item.id} artifact={artifact} />)}</ul>
                    {detailQueries.data.artifacts.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No artifacts were attached.</p>}
                  </section>
                </div>}
              </div>}
            </li>
          })}
        </ol>
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="text-muted-foreground">Page {pageIndex + 1} · {runPage.page.returned} runs</span>
          <div className="flex gap-2"><Button variant="outline" size="sm" disabled={pageIndex === 0} onClick={previousPage}>Previous</Button><Button variant="outline" size="sm" disabled={!runPage.page.hasMore} onClick={nextPage}>Next</Button></div>
        </div>
      </section>}
    </main>
  )
}
