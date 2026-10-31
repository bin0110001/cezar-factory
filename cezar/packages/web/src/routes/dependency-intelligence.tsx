import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { AlertTriangleIcon, CircleCheckIcon, CircleHelpIcon, DownloadIcon, GitBranchIcon, PlusIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DependencyGraphCanvas } from '@/components/dependency-graph-canvas'
import { dispatchDependencyCyclePlan, dispatchDependencyDecisionResearch, getDecisionDiscoveryCandidates, getDependencyCycles, getDependencyDecisionRanking, getDependencyDiagnosticsExport, getDependencyGraph, getDependencyGraphEvents, getDependencyGraphHealth, getDependencyGraphTrends, getDependencyNeighborhood, getDependencyRepairCandidates, proposeDependencyDecision, simulateDependencyGraph, syncDependencyGraph, transitionDependencyDecision } from '@/api/client'

const key = ['dependency-graph'] as const

export function DependencyIntelligenceRoute() {
  const client = useQueryClient()
  const [offset, setOffset] = useState(0)
  const [snapshotRevision, setSnapshotRevision] = useState<number | undefined>()
  const [search, setSearch] = useState('')
  const [repositoryFilter, setRepositoryFilter] = useState('')
  const [kind, setKind] = useState('')
  const [state, setState] = useState('')
  const [readinessFilter, setReadinessFilter] = useState('')
  const [completeIds, setCompleteIds] = useState<string[]>([])
  const [resolveIds, setResolveIds] = useState<string[]>([])
  const [simulation, setSimulation] = useState<Awaited<ReturnType<typeof simulateDependencyGraph>> | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState('')
  const [rationale, setRationale] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [evidenceLabel, setEvidenceLabel] = useState('')
  const [owner, setOwner] = useState('')
  const [authorization, setAuthorization] = useState<'agent-proposal' | 'human-approval'>('agent-proposal')
  const [reversible, setReversible] = useState(false)
  const [affectedNodeIds, setAffectedNodeIds] = useState('')
  const [editingDecisionId, setEditingDecisionId] = useState<string | null>(null)
  const [resolvingDecisionId, setResolvingDecisionId] = useState<string | null>(null)
  const [resolutionText, setResolutionText] = useState('')
  const graph = useQuery({ queryKey: [...key, offset, snapshotRevision, search, repositoryFilter, kind, state, readinessFilter], queryFn: () => getDependencyGraph({ limit: 100, offset, revision: snapshotRevision, search: search || undefined, repository: repositoryFilter || undefined, kind: kind as 'issue' | 'epic' | 'decision' | 'milestone' | 'external-blocker' | undefined, state: state || undefined, readiness: readinessFilter as 'ready' | 'blocked' | 'unknown' | undefined }), staleTime: 30_000 })
  const history = useQuery({ queryKey: [...key, 'events'], queryFn: () => getDependencyGraphEvents({ limit: 25 }), staleTime: 30_000 })
  const trends = useQuery({ queryKey: [...key, 'trends'], queryFn: getDependencyGraphTrends, staleTime: 30_000 })
  const cycles = useQuery({ queryKey: [...key, 'cycles'], queryFn: () => getDependencyCycles(20), staleTime: 30_000 })
  const repairCandidates = useQuery({ queryKey: [...key, 'repair-candidates'], queryFn: () => getDependencyRepairCandidates(20), staleTime: 30_000 })
  const ranking = useQuery({ queryKey: [...key, 'decision-ranking'], queryFn: () => getDependencyDecisionRanking(20), staleTime: 30_000 })
  const health = useQuery({ queryKey: [...key, 'health'], queryFn: getDependencyGraphHealth, staleTime: 30_000 })
  const discovery = useQuery({ queryKey: [...key, 'discovery'], queryFn: () => getDecisionDiscoveryCandidates({ limit: 20 }), staleTime: 30_000 })
  const neighborhood = useQuery({
    queryKey: [...key, 'neighborhood', expandedId],
    queryFn: () => getDependencyNeighborhood({ id: expandedId!, direction: 'both', depth: 2, limit: 50 }),
    enabled: expandedId !== null,
  })
  const sync = useMutation({ mutationFn: syncDependencyGraph, onSuccess: async () => { setOffset(0); setSnapshotRevision(undefined); await client.invalidateQueries({ queryKey: key }) } })
  const proposal = useMutation({ mutationFn: proposeDependencyDecision, onSuccess: async () => { setEditingDecisionId(null); setQuestion(''); setOptions(''); setRationale(''); setEvidenceUrl(''); setEvidenceLabel(''); setOwner(''); setAuthorization('agent-proposal'); setReversible(false); setAffectedNodeIds(''); await client.invalidateQueries({ queryKey: key }) } })
  const transition = useMutation({ mutationFn: transitionDependencyDecision, onSuccess: async () => { await client.invalidateQueries({ queryKey: key }) } })
  const simulate = useMutation({ mutationFn: simulateDependencyGraph, onSuccess: setSimulation })
  const diagnosticsExport = useMutation({ mutationFn: () => getDependencyDiagnosticsExport(), onSuccess: (value) => downloadJson(value, 'dependency-diagnostics.json') })
  const cyclePlan = useMutation({ mutationFn: dispatchDependencyCyclePlan, onSuccess: async () => { await client.invalidateQueries({ queryKey: key }) } })
  const decisionResearch = useMutation({ mutationFn: dispatchDependencyDecisionResearch, onSuccess: async () => { await client.invalidateQueries({ queryKey: key }) } })
  const data = graph.data
  const rankedDecisions = new Map((ranking.data?.decisions ?? []).map((item) => [item.id, item]))

  return <main className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Project intelligence</p>
        <h1 className="mt-2 text-2xl font-semibold">Dependencies</h1>
        <p className="mt-1 text-sm text-muted-foreground">Verified GitHub blockers and local readiness, with source freshness shown on every view.</p>
      </div>
      <div className="flex gap-2"><Button variant="outline" disabled={diagnosticsExport.isPending} onClick={() => diagnosticsExport.mutate()}><DownloadIcon className="mr-2 size-4" />Export diagnostics</Button><Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}><RefreshCwIcon className={`mr-2 size-4 ${sync.isPending ? 'animate-spin' : ''}`} /> Sync from GitHub</Button></div>
    </header>

    {graph.isPending ? <div className="rounded-xl border p-8 text-sm text-muted-foreground">Loading the local dependency projection…</div>
      : graph.isError ? <section className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm" role="alert">
        <p className="font-medium">Dependency data is unavailable.</p><p className="mt-1 text-muted-foreground">{graph.error.message}</p>
      </section>
        : data ? <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Source status" value={data.source.status} icon={data.source.status === 'fresh' ? CircleCheckIcon : data.source.status === 'unknown' ? CircleHelpIcon : AlertTriangleIcon} />
            <Metric label="Ready" value={`${health.data?.counts.ready ?? '—'}`} icon={CircleCheckIcon} />
            <Metric label="Blocked" value={`${health.data?.counts.blocked ?? '—'}`} icon={AlertTriangleIcon} />
            <Metric label="Unknown" value={`${health.data?.counts.unknown ?? '—'}`} icon={CircleHelpIcon} />
            <Metric label="Blocking cycles" value={`${health.data?.counts.cycles ?? '—'}`} icon={GitBranchIcon} />
          </section>
          {health.data && <section className="grid gap-3 sm:grid-cols-3">
            <Metric label="Oldest open issue" value={health.data.aging.oldestOpenIssueAgeDays === null ? 'Unknown' : `${health.data.aging.oldestOpenIssueAgeDays} days`} icon={CircleHelpIcon} />
            <Metric label="Age of oldest blocked issue" value={health.data.aging.oldestBlockedIssueAgeDays === null ? 'Unknown' : `${health.data.aging.oldestBlockedIssueAgeDays} days`} icon={AlertTriangleIcon} />
            <Metric label="Blocked duration" value="Unavailable" icon={CircleHelpIcon} />
          </section>}
          {health.data && <section className="grid gap-4 rounded-xl border p-4 md:grid-cols-2">
            <div><h2 className="text-sm font-medium">Top direct bottlenecks</h2>{health.data.diagnostics.bottlenecks.length ? <ul className="mt-2 space-y-1">{health.data.diagnostics.bottlenecks.slice(0, 5).map((item) => <li key={item.nodeId}><button className="text-left text-xs underline underline-offset-2" onClick={() => { setSearch(item.nodeId); setRepositoryFilter(''); setKind(''); setState(''); setReadinessFilter(''); setOffset(0); setSnapshotRevision(undefined) }}>{item.nodeId}</button><span className="ml-2 text-xs text-muted-foreground">blocks {item.directBlockedIssues}</span></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No direct open blocker bottlenecks.</p>}</div>
            <div><h2 className="text-sm font-medium">Closed issues still linked as blockers</h2>{health.data.diagnostics.obsoleteBlockers.length ? <ul className="mt-2 space-y-1">{health.data.diagnostics.obsoleteBlockers.slice(0, 5).map((item) => <li key={item.edgeId} className="text-xs"><button className="underline underline-offset-2" onClick={() => { setSearch(item.blockerId); setRepositoryFilter(''); setKind(''); setState(''); setReadinessFilter(''); setOffset(0); setSnapshotRevision(undefined) }}>{item.blockerId}</button><span className="mx-1">→</span><button className="underline underline-offset-2" onClick={() => { setSearch(item.dependentId); setRepositoryFilter(''); setKind(''); setState(''); setReadinessFilter(''); setOffset(0); setSnapshotRevision(undefined) }}>{item.dependentId}</button></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No closed blockers currently point to open issues.</p>}</div>
            <p className="text-xs text-muted-foreground md:col-span-2">Issue age is measured from creation to this snapshot. {health.data.aging.unknownIssueAgeCount} open issues lack a creation date; blocked duration is unavailable because there is no verified blocked-since timestamp.</p>
          </section>}
          {data.source.warning && <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">{data.source.warning}</p>}
          <section className="overflow-hidden rounded-xl border">
            <div className="space-y-3 border-b px-4 py-3">
              <div className="text-sm font-medium">Dependency nodes <span className="ml-2 text-muted-foreground">revision {data.revision} · {data.repository}</span></div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <label className="sr-only" htmlFor="dependency-search">Search dependency nodes</label><input id="dependency-search" className="rounded-md border bg-background px-3 py-2 text-sm" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); setSnapshotRevision(undefined) }} placeholder="Search title or issue ID" />
                <label className="sr-only" htmlFor="dependency-repository">Filter by repository</label><input id="dependency-repository" className="rounded-md border bg-background px-3 py-2 text-sm" value={repositoryFilter} onChange={(event) => { setRepositoryFilter(event.target.value); setOffset(0); setSnapshotRevision(undefined) }} placeholder="Repository owner/name" />
                <label className="sr-only" htmlFor="dependency-kind">Filter by node type</label><select id="dependency-kind" className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); setSnapshotRevision(undefined) }}><option value="">All node types</option><option value="issue">Issues</option><option value="epic">Epics</option><option value="decision">Decisions</option><option value="milestone">Milestones</option><option value="external-blocker">External blockers</option></select>
                <label className="sr-only" htmlFor="dependency-state">Filter by state</label><select id="dependency-state" className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={state} onChange={(event) => { setState(event.target.value); setOffset(0); setSnapshotRevision(undefined) }}><option value="">All states</option><option value="open">Open</option><option value="closed">Closed</option><option value="resolved">Resolved</option><option value="proposed">Proposed</option><option value="approved">Approved</option><option value="deferred">Deferred</option></select>
                <label className="sr-only" htmlFor="dependency-readiness">Filter by readiness</label><select id="dependency-readiness" className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={readinessFilter} onChange={(event) => { setReadinessFilter(event.target.value); setOffset(0); setSnapshotRevision(undefined) }}><option value="">All readiness</option><option value="ready">Ready</option><option value="blocked">Blocked</option><option value="unknown">Unknown</option></select>
              </div>
            </div>
            {data.nodes.length ? <ul className="divide-y">
              {data.nodes.map((node) => <li key={node.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">{node.url ? <a className="block truncate text-sm font-medium underline-offset-2 hover:underline" href={node.url} target="_blank" rel="noopener noreferrer">{node.title || node.id}</a> : <p className="truncate text-sm font-medium">{node.title || node.id}</p>}<p className="mt-1 truncate font-mono text-xs text-muted-foreground">{node.id}</p></div>
                <div className="flex shrink-0 items-center gap-2"><span className="rounded-full bg-muted px-2 py-1 text-xs">{node.kind} · {node.state}</span><Button size="sm" variant="outline" aria-expanded={expandedId === node.id} onClick={() => setExpandedId(expandedId === node.id ? null : node.id)}>Expand</Button></div>
              </li>)}
            </ul> : <p className="p-6 text-sm text-muted-foreground">No local graph yet. Sync from GitHub to build the first projection.</p>}
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-xs text-muted-foreground">Showing {data.nodes.length ? offset + 1 : 0}–{offset + data.nodes.length} of {data.page.totalNodes}</p>
              <div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.page.limit))}>Previous</Button><Button size="sm" variant="outline" disabled={!data.page.hasMore} onClick={() => { setSnapshotRevision(data.revision); setOffset(offset + data.page.limit) }}>Next</Button></div>
            </div>
          </section>
          <section className="space-y-4 rounded-xl border p-4" aria-label="What-if simulation">
            <div><h2 className="text-sm font-medium">What-if simulation</h2><p className="mt-1 text-xs text-muted-foreground">Simulates selected issue completions and decision outcomes against revision {data.revision}. Changes stay local.</p></div>
            <div className="grid gap-4 md:grid-cols-2">
              <fieldset className="space-y-2"><legend className="text-xs font-medium">Complete open issues on this page</legend><div className="max-h-36 space-y-1 overflow-auto">{data.nodes.filter((node) => (node.kind === 'issue' || node.kind === 'epic') && node.state === 'open').map((node) => <label key={node.id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={completeIds.includes(node.id)} onChange={(event) => setCompleteIds((ids) => event.target.checked ? [...ids, node.id] : ids.filter((id) => id !== node.id))} /><span>{node.title || node.id}</span></label>)}</div></fieldset>
              <fieldset className="space-y-2"><legend className="text-xs font-medium">Resolve decisions on this page</legend><div className="max-h-36 space-y-1 overflow-auto">{data.decisions.filter((decision) => !['resolved', 'rejected', 'superseded'].includes(decision.state)).map((decision) => <label key={decision.id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={resolveIds.includes(decision.id)} onChange={(event) => setResolveIds((ids) => event.target.checked ? [...ids, decision.id] : ids.filter((id) => id !== decision.id))} /><span>{decision.question}</span></label>)}</div></fieldset>
            </div>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={simulate.isPending || (!completeIds.length && !resolveIds.length) || data.source.status !== 'fresh'} onClick={() => simulate.mutate({ expectedRevision: data.revision, completeNodeIds: completeIds, resolveDecisionIds: resolveIds })}>Run simulation</Button>
              {simulation && <Button size="sm" variant="ghost" onClick={() => { const safe = { repository: data.repository, revision: simulation.revision, scenario: { completedIssues: simulation.hypotheticalCompletions, resolvedDecisions: simulation.hypotheticalDecisionOutcomes }, result: simulation }; const url = URL.createObjectURL(new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `dependency-scenario-r${simulation.revision}.json`; anchor.click(); URL.revokeObjectURL(url) }}><DownloadIcon className="mr-2 size-4" />Export scenario</Button>}</div>
            {simulate.isError && <p className="text-sm text-destructive" role="alert">{simulate.error.message}</p>}
            {simulation && <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-xs"><p>Snapshot r{simulation.revision} · {simulation.freshness} · not persisted</p><p>{simulation.before.filter((item) => item.readiness === 'blocked').length} blocked before → {simulation.after.filter((item) => item.readiness === 'blocked').length} after; {simulation.before.filter((item) => item.readiness === 'ready').length} ready before → {simulation.after.filter((item) => item.readiness === 'ready').length} after.</p><p>Critical path unavailable: {simulation.criticalPath.reason}</p><p>Cycles: {simulation.cyclesBefore.length} before → {simulation.cyclesAfter.length} after</p></div>}
          </section>
          {expandedId && <section className="overflow-hidden rounded-xl border" aria-label="Dependency neighborhood">
            <div className="flex items-center justify-between border-b px-4 py-3"><div><p className="text-sm font-medium">Neighborhood</p><p className="mt-1 font-mono text-xs text-muted-foreground">{expandedId}</p></div><Button size="sm" variant="outline" onClick={() => setExpandedId(null)}>Close</Button></div>
            {neighborhood.isPending ? <p className="p-4 text-sm text-muted-foreground">Expanding nearby dependencies…</p>
              : neighborhood.isError ? <p className="p-4 text-sm text-destructive" role="alert">{neighborhood.error.message}</p>
                : neighborhood.data ? <div className="space-y-4 p-4"><DependencyGraphCanvas graph={neighborhood.data} onExpand={setExpandedId} /><ul className="divide-y rounded-lg border">{neighborhood.data.nodes.map((node) => <li key={node.id} className="flex items-center justify-between gap-3 px-4 py-2"><span className="truncate text-sm">{node.title || node.id}</span><div className="flex shrink-0 items-center gap-2"><span className="text-xs text-muted-foreground">{node.kind} · {node.state}</span><Button size="sm" variant="ghost" onClick={() => setExpandedId(node.id)}>Expand</Button></div></li>)}</ul><div className="space-y-2 border-t pt-3">{neighborhood.data.edges.map((edge) => <p key={edge.id} className="truncate text-xs"><span className="mr-2 rounded bg-muted px-1.5 py-0.5">{edge.kind}</span><span className="font-mono text-muted-foreground">{edge.from} → {edge.to}</span></p>)}<p className="text-xs text-muted-foreground">{neighborhood.data.edges.length} edges · revision {neighborhood.data.revision}{neighborhood.data.truncated ? ' · expansion capped' : ''}</p></div></div> : null}
          </section>}
          <section className="overflow-hidden rounded-xl border">
            <div className="border-b px-4 py-3 text-sm font-medium">Recent graph history</div>
            {history.data?.events.length ? <ul className="divide-y">
              {history.data.events.map((event) => <li key={event.cursor} className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
                <span><span className="font-medium">{event.kind}</span><span className="ml-2 font-mono text-xs text-muted-foreground">{event.entityId}</span></span>
                <span className="text-xs text-muted-foreground">r{event.revision} · {event.actor} · {new Date(event.createdAt).toLocaleString()}</span>
              </li>)}
            </ul> : <p className="p-4 text-sm text-muted-foreground">No local graph events have been recorded yet.</p>}
          </section>
          <section className="overflow-hidden rounded-xl border">
            <div className="border-b px-4 py-3 text-sm font-medium">Historical bottlenecks <span className="ml-2 text-xs font-normal text-muted-foreground">weekly immutable snapshot samples</span></div>
            {trends.data?.points.length ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b text-muted-foreground"><th className="px-4 py-2">Week</th><th className="px-3 py-2">Ready / blocked / unknown</th><th className="px-3 py-2">Cycles</th><th className="px-3 py-2">Oldest blocked age</th><th className="px-3 py-2">Resolved decisions Δ</th><th className="px-3 py-2">Recurring cycles</th></tr></thead><tbody>{trends.data.points.map((point) => <tr key={point.week} className="border-b last:border-0"><td className="px-4 py-2">{point.week} · r{point.revision} · {point.sourceStatus}</td><td className="px-3 py-2">{point.readiness.ready} / {point.readiness.blocked} / {point.readiness.unknown}</td><td className="px-3 py-2">{point.cycles}</td><td className="px-3 py-2">{point.oldestBlockedIssueAgeDays === null ? 'Unknown' : `${point.oldestBlockedIssueAgeDays} days`}</td><td className="px-3 py-2">{point.resolvedDecisionDelta > 0 ? '+' : ''}{point.resolvedDecisionDelta}</td><td className="px-3 py-2">{point.recurringCycleSignatures.length}</td></tr>)}</tbody></table></div> : <p className="p-4 text-sm text-muted-foreground">Weekly history appears as graph revisions accumulate.</p>}
            {trends.data?.truncated && <p className="border-t p-3 text-xs text-muted-foreground">History is limited to the latest 100 revisions.</p>}
          </section>
          <section className="overflow-hidden rounded-xl border">
            <div className="border-b px-4 py-3 text-sm font-medium">Decision proposals</div>
            {data.decisions.length ? <ul className="divide-y">
              {data.decisions.map((decision) => <li key={decision.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{decision.question}</p><span className="rounded-full bg-muted px-2 py-1 text-xs">{decision.state}</span></div>
                <p className="text-xs text-muted-foreground">Options: {decision.options.join(' · ')}</p>
                {rankedDecisions.has(decision.id) && (() => { const score = rankedDecisions.get(decision.id)!; return <p className="text-xs text-muted-foreground">{score.immediateUnlock === null ? 'Unlock estimate unknown while source is stale.' : `${score.immediateUnlock} immediate unlocks`} · reach {score.downstreamReach} · score {score.score ?? 'unknown'} · oldest affected issue {score.oldestAffectedIssueAgeDays === null ? 'age unknown' : `${score.oldestAffectedIssueAgeDays} days`}{score.unknownAgeReach ? ` · age unknown for ${score.unknownAgeReach}` : ''} · blocked duration unavailable</p> })()}
                {decision.rationale && <p className="text-sm text-muted-foreground">{decision.rationale}</p>}
                 {decision.createdBy === 'dependency-discovery-scanner' && <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={decisionResearch.isPending || data.source.status !== 'fresh'} onClick={() => decisionResearch.mutate({ expectedGraphRevision: data.revision, decisionId: decision.id })}>Ask bounded researcher</Button>{decisionResearch.data?.fingerprint === decision.id && <span className="text-xs text-muted-foreground" role="status">Research run {decisionResearch.data.runId ?? decisionResearch.data.reason}</span>}</div>}
                {decision.requiredAuthorization === 'agent-proposal' && ['proposed', 'reopened'].includes(decision.state) && <Button size="sm" variant="ghost" onClick={() => { setEditingDecisionId(decision.id); setQuestion(decision.question); setOptions(decision.options.join('\n')); setRationale(decision.rationale); setEvidenceUrl(decision.evidence[0]?.url ?? ''); setEvidenceLabel(decision.evidence[0]?.label ?? ''); setOwner(decision.owner ?? ''); setAuthorization('agent-proposal'); setReversible(decision.reversible); setAffectedNodeIds(decision.affectedNodeIds.join('\n')); document.getElementById('decision-form')?.scrollIntoView({ behavior: 'smooth' }) }}>Edit proposal</Button>}
                {data.source.status === 'fresh' && <div className="flex flex-wrap gap-2">
                  {['proposed', 'reopened'].includes(decision.state) && <Button size="sm" variant="outline" disabled={transition.isPending} onClick={() => transition.mutate({ expectedGraphRevision: data.revision, decisionId: decision.id, to: 'approved' })}>Approve</Button>}
                  {['reopened', 'approved'].includes(decision.state) && <Button size="sm" variant="outline" disabled={transition.isPending} onClick={() => transition.mutate({ expectedGraphRevision: data.revision, decisionId: decision.id, to: 'deferred' })}>Defer</Button>}
                  {decision.state === 'approved' && (resolvingDecisionId === decision.id ? <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (!resolutionText.trim()) return; transition.mutate({ expectedGraphRevision: data.revision, decisionId: decision.id, to: 'resolved', resolution: resolutionText }, { onSuccess: () => { setResolvingDecisionId(null); setResolutionText('') } }) }}><label className="sr-only" htmlFor={`decision-resolution-${decision.id}`}>Decision outcome</label><input id={`decision-resolution-${decision.id}`} className="min-w-56 rounded-md border bg-background px-3 py-2 text-sm text-foreground" maxLength={8000} required value={resolutionText} onChange={(event) => setResolutionText(event.target.value)} placeholder="Enter the decision outcome" /><Button size="sm" type="submit" variant="outline" disabled={transition.isPending}>Save outcome</Button><Button size="sm" type="button" variant="ghost" onClick={() => { setResolvingDecisionId(null); setResolutionText('') }}>Cancel</Button></form> : <Button size="sm" variant="outline" onClick={() => setResolvingDecisionId(decision.id)}>Resolve</Button>)}
                  {['proposed', 'reopened', 'approved'].includes(decision.state) && <Button size="sm" variant="ghost" disabled={transition.isPending} onClick={() => transition.mutate({ expectedGraphRevision: data.revision, decisionId: decision.id, to: 'rejected' })}>Reject</Button>}
                  {['deferred', 'resolved', 'rejected'].includes(decision.state) && <Button size="sm" variant="ghost" disabled={transition.isPending} onClick={() => transition.mutate({ expectedGraphRevision: data.revision, decisionId: decision.id, to: 'reopened' })}>Reopen</Button>}
                </div>}
              </li>)}
            </ul> : <p className="p-4 text-sm text-muted-foreground">No local decision proposals are recorded.</p>}
            {transition.isError && <p className="border-t p-3 text-sm text-destructive" role="alert">{transition.error.message}</p>}
            {decisionResearch.isError && <p className="border-t p-3 text-sm text-destructive" role="alert">{decisionResearch.error.message}</p>}
            {data.source.status === 'fresh' && <form id="decision-form" className="space-y-3 border-t p-4" onSubmit={(event) => {
              event.preventDefault()
              const choices = options.split(/\r?\n/).map((option) => option.trim()).filter(Boolean)
              const repoPath = data.repository.split('/').length === 2 ? `github.com/${data.repository}` : data.repository
              proposal.mutate({ expectedGraphRevision: data.revision, id: editingDecisionId ?? `decision:${repoPath}:${crypto.randomUUID()}`, question, options: choices, rationale, owner: owner || undefined, reversible, requiredAuthorization: authorization, affectedNodeIds: affectedNodeIds.split(/\r?\n/).map((id) => id.trim()).filter(Boolean), evidence: evidenceUrl ? [{ url: evidenceUrl, label: evidenceLabel || 'Supporting evidence' }] : [] })
            }}>
              <p className="text-sm font-medium">{editingDecisionId ? 'Edit decision proposal' : 'Propose a decision'}</p>
              <label className="block text-xs text-muted-foreground">Question<input className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground" required maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What needs to be decided?" /></label>
              <label className="block text-xs text-muted-foreground">Options, one per line<textarea className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground" required maxLength={8000} value={options} onChange={(event) => setOptions(event.target.value)} placeholder={'Option A\nOption B'} rows={3} /></label>
              <label className="block text-xs text-muted-foreground">Rationale<textarea className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground" maxLength={8000} value={rationale} onChange={(event) => setRationale(event.target.value)} rows={2} /></label>
              <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs text-muted-foreground">Owner<input className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground" maxLength={256} value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Optional owner" /></label><label className="block text-xs text-muted-foreground">Required authorization<select className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={authorization} onChange={(event) => setAuthorization(event.target.value as 'agent-proposal' | 'human-approval')}><option value="agent-proposal">Agent proposal</option><option value="human-approval">Human approval</option></select></label></div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={reversible} onChange={(event) => setReversible(event.target.checked)} />This decision is reversible</label>
              <label className="block text-xs text-muted-foreground">Affected issue IDs, one per line<textarea className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground" value={affectedNodeIds} onChange={(event) => setAffectedNodeIds(event.target.value)} rows={2} placeholder="issue:github.com/owner/repo:123" /></label>
              <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs text-muted-foreground">Evidence URL<input type="url" className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} /></label><label className="block text-xs text-muted-foreground">Evidence label<input className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground" maxLength={256} value={evidenceLabel} onChange={(event) => setEvidenceLabel(event.target.value)} /></label></div>
              <div className="flex gap-2"><Button size="sm" disabled={proposal.isPending || options.split(/\r?\n/).filter((option) => option.trim()).length < 2}><PlusIcon className="mr-2 size-4" />{editingDecisionId ? 'Save changes' : 'Save proposal'}</Button>{editingDecisionId && <Button size="sm" type="button" variant="outline" onClick={() => { setEditingDecisionId(null); setQuestion(''); setOptions(''); setRationale(''); setEvidenceUrl(''); setEvidenceLabel(''); setOwner(''); setReversible(false); setAffectedNodeIds('') }}>Cancel edit</Button>}</div>
              {proposal.isError && <p className="text-sm text-destructive" role="alert">{proposal.error.message}</p>}
            </form>}
          </section>
          <section className="overflow-hidden rounded-xl border">
            <div className="border-b px-4 py-3 text-sm font-medium">Potential shared decisions <span className="ml-2 text-xs font-normal text-muted-foreground">deterministic text matches · suggestions only</span></div>
            {discovery.data?.candidates.length ? <ul className="divide-y">
              {discovery.data.candidates.map((candidate) => <li key={candidate.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{candidate.question}</p><span className="text-xs text-muted-foreground">confidence {Math.round(candidate.confidence * 100)}%</span></div>
                <p className="text-xs text-muted-foreground">Affects {candidate.affectedNodeIds.length} issues · {candidate.sharedBlockerIds.length} shared blockers</p>
                <ul className="space-y-1">{candidate.evidence.map((item) => <li key={item.nodeId} className="truncate text-xs"><a className="font-mono underline-offset-2 hover:underline" href={item.url} target="_blank" rel="noopener noreferrer">{item.nodeId}</a><span className="ml-2 text-muted-foreground">{item.excerpt}</span></li>)}</ul>
                <Button size="sm" variant="outline" disabled={data.source.status !== 'fresh'} onClick={() => { setEditingDecisionId(null); setQuestion(candidate.question); setOptions('Create a shared contract issue\nKeep the existing interfaces and resolve blockers separately'); setRationale(`Deterministic candidate matched repeated issue text. Shared blockers: ${candidate.sharedBlockerIds.join(', ') || 'none detected'}. Review the cited issues before accepting.`); setAffectedNodeIds(candidate.affectedNodeIds.join('\n')); setEvidenceUrl(candidate.evidence[0]?.url ?? ''); setEvidenceLabel('Candidate issue evidence'); setAuthorization('agent-proposal'); setReversible(false); document.getElementById('decision-form')?.scrollIntoView({ behavior: 'smooth' }) }}>Review as proposal</Button>
              </li>)}
            </ul> : <p className="p-4 text-sm text-muted-foreground">No repeated unresolved decision phrasing was found in the bounded scan.</p>}
          </section>
          <section className="overflow-hidden rounded-xl border">
            <div className="border-b px-4 py-3 text-sm font-medium">Verified blocking cycles</div>
            {cycles.data?.cycles.length ? <ul className="divide-y">
              {cycles.data.cycles.map((cycle) => <li key={cycle.nodeIds.join('|')} className="space-y-2 px-4 py-3">
                <p className="text-sm font-medium">{cycle.nodeIds.length} issues in a blocking cycle</p>
                <p className="font-mono text-xs text-muted-foreground">{cycle.witnessNodeIds.join(' → ')}</p>
              </li>)}
            </ul> : <p className="p-4 text-sm text-muted-foreground">No verified blocking cycles found in this snapshot.</p>}
          </section>
          <section className="overflow-hidden rounded-xl border">
            <div className="border-b px-4 py-3 text-sm font-medium">Cycle repair plans <span className="ml-2 text-xs font-normal text-muted-foreground">review only · verified blockers are never changed</span></div>
            {repairCandidates.data?.candidates.length ? <ul className="divide-y">{repairCandidates.data.candidates.map((candidate) => <li key={candidate.id} className="space-y-2 px-4 py-3"><p className="text-sm font-medium">Contract first decomposition · revision {candidate.graphRevision}</p><p className="text-sm text-muted-foreground">{candidate.proposal}</p><p className="text-xs text-muted-foreground">{candidate.cycleNodeIds.length} cycle nodes · {candidate.affectedIssueIds.length} downstream issues · simulation preserves {candidate.simulation.cyclesAfter} cycle(s). Human review required.</p><ul className="space-y-1">{candidate.evidence.map((edge) => <li key={edge.edgeId} className="truncate font-mono text-xs text-muted-foreground">{edge.from} → {edge.to}{edge.sourceUrl ? <> · <a href={edge.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">source</a></> : null}</li>)}</ul><div className="flex flex-wrap items-center gap-2"><p className="text-xs text-muted-foreground">{candidate.rationale}</p><Button size="sm" variant="outline" disabled={cyclePlan.isPending || data.source.status !== 'fresh'} onClick={() => cyclePlan.mutate({ expectedGraphRevision: candidate.graphRevision, candidateId: candidate.id })}>Ask read only planner</Button></div>{cyclePlan.data?.fingerprint && <p className="text-xs text-muted-foreground" role="status">Planner run {cyclePlan.data.runId ?? cyclePlan.data.reason} · cycle {cyclePlan.data.fingerprint}</p>}</li>)}</ul> : <p className="p-4 text-sm text-muted-foreground">No repair review plans are needed for this snapshot.</p>}
            {cyclePlan.isError && <p className="border-t p-3 text-sm text-destructive" role="alert">{cyclePlan.error.message}</p>}
          </section>
        </> : null}
    {sync.isError && <p className="text-sm text-destructive" role="alert">{sync.error.message}</p>}
    {sync.data?.warning && <p className="text-sm text-pending-strong">{sync.data.warning}</p>}
    {diagnosticsExport.isError && <p className="text-sm text-destructive" role="alert">{diagnosticsExport.error.message}</p>}
  </main>
}

function Metric({ label, value, icon: Icon }: { label: string; value: string; icon: typeof GitBranchIcon }) {
  return <div className="rounded-xl border p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-4" />{label}</div><p className="mt-3 text-xl font-semibold capitalize">{value}</p></div>
}

function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
