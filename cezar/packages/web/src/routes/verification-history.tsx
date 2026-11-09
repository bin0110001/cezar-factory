import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircleIcon, ChevronDownIcon, ChevronRightIcon, FileTextIcon, RefreshCwIcon } from 'lucide-react'
import type { VerificationQueryResponse } from '@open-mercato/cezar-api-client'
import { getVerificationArtifact, queryVerificationHistory } from '@/api/client'
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
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [pageIndex, setPageIndex] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [trendCheckId, setTrendCheckId] = useState<string | null>(null)
  const cursor = cursors[pageIndex]
  const page = useQuery({
    queryKey: [...historyKey, 'runs', status, cursor],
    queryFn: ({ signal }) => queryVerificationHistory({ kind: 'runs', pageSize: HISTORY_PAGE_SIZE, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }, { signal }),
    staleTime: 15_000,
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
  }
  const nextPage = () => {
    if (!runPage?.page.nextCursor) return
    const next = [...cursors.slice(0, pageIndex + 1), runPage.page.nextCursor]
    setCursors(next)
    setPageIndex(next.length - 1)
    setSelectedRunId(null)
  }
  const previousPage = () => { setPageIndex((index) => Math.max(0, index - 1)); setSelectedRunId(null) }

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
              <button className="grid w-full grid-cols-[minmax(0,1.6fr)_minmax(6rem,.8fr)_minmax(8rem,1fr)_minmax(7rem,.8fr)] items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/30" aria-expanded={expanded} onClick={() => { setSelectedRunId(expanded ? null : item.id); setTrendCheckId(null) }}>
                <span className="flex min-w-0 items-center gap-2">{expanded ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}<span className="min-w-0"><span className="block truncate font-medium">{item.id}</span><span className="block truncate font-mono text-xs text-muted-foreground">{item.commitSha.slice(0, 10)} · {item.checks?.length ?? 0} checks</span></span></span>
                <span className={statusColor(item.status)}>{item.status}</span>
                <span className="text-xs text-muted-foreground">{item.counts.selected} selected · {item.counts.deferred} deferred · {item.counts.failures} failed</span>
                <time className="text-xs text-muted-foreground">{when(item.startedAt)}</time>
              </button>
              {expanded && <div className="border-t bg-muted/10 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div><p className="font-medium">Suite: {item.suite ?? 'verification'}</p><p className="text-xs text-muted-foreground">Finished {when(item.finishedAt)}</p></div>
                  {detailQueries.isFetching && <span className="text-xs text-muted-foreground" role="status">Loading run evidence…</span>}
                </div>
                {detailQueries.isError && <p className="mt-3 text-sm text-destructive" role="alert">Run details could not be loaded: {detailQueries.error.message}</p>}
                {detailQueries.data && <div className="mt-4 grid gap-5 xl:grid-cols-2">
                  <section>
                    <h2 className="text-sm font-semibold">Selected checks</h2>
                    <ul className="mt-2 space-y-2 text-sm">{detailQueries.data.selected.map((entry) => <li key={entry.testId} className="rounded border p-2"><span className="font-mono">{entry.testId}</span><p className="mt-1 text-xs text-muted-foreground">{boundedText(entry.reason)}</p></li>)}</ul>
                    {detailQueries.data.selected.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No selection details were recorded.</p>}
                    <h2 className="mt-4 text-sm font-semibold">Deferred checks</h2>
                    <ul className="mt-2 space-y-2 text-sm">{detailQueries.data.deferred.map((entry) => <li key={entry.testId} className="rounded border p-2"><span className="font-mono">{entry.testId}</span><p className="mt-1 text-xs text-muted-foreground">{boundedText(entry.reason)}</p></li>)}</ul>
                    {detailQueries.data.deferred.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No checks were deferred.</p>}
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
