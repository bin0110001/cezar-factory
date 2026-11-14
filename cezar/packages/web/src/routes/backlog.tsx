import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { AlertTriangleIcon, RefreshCwIcon, Undo2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BacklogDependencyMap } from '@/components/backlog-dependency-map'
import { LANE_TRIGGER_LABELS, LANE_WORK } from './backlog-lanes'
import { editBacklogIssue, getAutomations, getBacklog, getBacklogRecommendation, type BacklogCardData } from '@/api/client'

const key = ['backlog'] as const
const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4', 'unset'] as const
function statusTone(kind: BacklogCardData['status']['kind']): string {
  if (kind === 'dispatchable' || kind === 'running') return 'text-emerald-600'
  if (kind === 'deferred') return 'text-pending-strong'
  return 'text-muted-foreground'
}

function cardStatusText(card: BacklogCardData): string {
  const laneGate = `lane is ${card.lane}, not Ready`
  if (card.status.reasonCode !== 'gated' || card.lane === 'Ready' || !card.status.detail.includes(laneGate)) {
    return `${card.status.reasonCode}: ${card.status.detail}`
  }
  const otherGates = card.status.detail.split('; ').filter((gate) => gate !== laneGate)
  return `outside implementation queue; this lane handles ${LANE_WORK[card.lane]}${otherGates.length ? `; additional gates: ${otherGates.join('; ')}` : ''}`
}

function nextPollEstimate(nextRunAt?: string): string | null {
  if (!nextRunAt) return null
  const timestamp = Date.parse(nextRunAt)
  if (!Number.isFinite(timestamp)) return null
  const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000))
  const localTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
  return minutes === 0 ? `due now or in progress (${localTime})` : `about ${minutes} min (${localTime})`
}

function LaneDispatchPreview({ lane, automationQuery }: {
  lane: { lane: string; cards: BacklogCardData[] }
  automationQuery: { data?: Awaited<ReturnType<typeof getAutomations>>; isPending: boolean; isError: boolean }
}) {
  const triggerLabels = LANE_TRIGGER_LABELS[lane.lane] ?? []
  const matching = automationQuery.data?.automations.filter((automation) =>
    automation.kind === 'github' && automation.filters?.changedLabels?.some((label) => triggerLabels.includes(label)),
  ) ?? []
  const enabled = matching.filter((automation) => automation.enabled)
  const nextAutomation = enabled
    .map((automation) => ({ automation, timestamp: Date.parse(automation.nextRunAt ?? '') }))
    .filter((item) => Number.isFinite(item.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)[0]?.automation
  const estimate = nextPollEstimate(nextAutomation?.nextRunAt)

  return (
    <div className="min-w-0 rounded-md bg-muted/40 p-2 text-xs" data-testid={`dispatch-preview-${lane.lane}`}>
      <p className="font-medium">Top-ranked candidate</p>
      {lane.cards[0]
        ? <p className="break-all font-mono">{lane.cards[0].id}</p>
        : <p className="text-muted-foreground">No current items</p>}
      {triggerLabels.length === 0
        ? <p className="mt-1 text-muted-foreground">No status triggered automation for this lane.</p>
        : automationQuery.isPending
          ? <p className="mt-1 text-muted-foreground">Loading automation schedule…</p>
          : automationQuery.isError
            ? <p className="mt-1 text-muted-foreground">Automation schedule unavailable.</p>
            : enabled.length === 0
              ? <p className="mt-1 text-muted-foreground">No enabled automation found for {triggerLabels.join(' / ')}.</p>
              : <>
                <p className="mt-1 break-words text-muted-foreground">{enabled.map((automation) => automation.name).join(', ')}</p>
                <p className="text-muted-foreground">Next automation check: {estimate ? `~${estimate}` : 'time unavailable'}</p>
              </>}
      <p className="mt-1 text-muted-foreground">Candidate follows the lane ranking. The check time is not a guaranteed pickup: a matching status event, filters, and scheduler capacity are still required.</p>
    </div>
  )
}

/** Backlog lanes with the scheduler's own reasons, conflict edges, merge debt and override audit (#201). */
export function BacklogRoute() {
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'board' | 'map'>('board')
  const overview = useQuery({ queryKey: key, queryFn: () => getBacklog(), staleTime: 15_000 })
  const recommendation = useQuery({ queryKey: [...key, 'recommendation'], queryFn: () => getBacklogRecommendation(5), staleTime: 15_000 })
  const automations = useQuery({ queryKey: ['automations'], queryFn: () => getAutomations(), staleTime: 15_000 })
  const edit = useMutation({
    mutationFn: editBacklogIssue,
    onSuccess: async () => { setError(null); await client.invalidateQueries({ queryKey: key }) },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'The edit was rejected'),
  })
  const view = overview.data
  const revisions = view?.revisions ?? {}
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="backlog-route">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Backlog</h1>
        <Button variant="outline" size="sm" onClick={() => void Promise.all([
          client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: ['automations'] }),
        ])}>
          <RefreshCwIcon className="size-4" /> Refresh
        </Button>
      </header>
      {error && <p role="alert" className="text-sm text-destructive"><AlertTriangleIcon className="mr-1 inline size-4" />{error}</p>}
      {overview.isError && <p role="alert" className="text-sm text-destructive">Backlog is unavailable: {(overview.error as Error).message}</p>}
      <Tabs value={tab} onValueChange={(value) => setTab(value === 'map' ? 'map' : 'board')}>
        <TabsList aria-label="Backlog views">
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="map">Dependency map</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'map' && <BacklogDependencyMap />}
      {tab === 'board' && recommendation.data && (
        <section aria-label="Next up" className="rounded-md border p-3 text-sm">
          <h2 className="font-medium">Next up for implementation</h2>
          {recommendation.data.next
            ? <p>{recommendation.data.next.id} — score {recommendation.data.next.score}; {recommendation.data.next.factors.slice(0, 3).map((f) => `${f.name} ${f.points}`).join(', ')}</p>
            : <p className="text-muted-foreground">No issues are eligible for implementation dispatch from the Ready lane.</p>}
          <p className="mt-1 text-muted-foreground">Factory also dispatches intake, investigation, planning, requested fixes, and review through their own automations. The lane columns below show where that work sits.</p>
          {recommendation.data.needsHuman.length > 0 && (
            <p className="mt-1 text-muted-foreground">Needs a human decision: {recommendation.data.needsHuman.map((n) => n.id).join(', ')}</p>
          )}
        </section>
      )}
      {tab === 'board' && view && (
        <>
          <div className="grid min-w-0 gap-3 md:grid-cols-4 xl:grid-cols-7">
            {view.lanes.map((lane) => (
              <section key={lane.lane} aria-label={lane.lane} className="flex min-w-0 flex-col gap-2">
                <div>
                  <h2 className="text-sm font-medium">{lane.lane} <span className="text-muted-foreground">({lane.cards.length})</span></h2>
                  <p className="text-xs text-muted-foreground">{LANE_WORK[lane.lane]}</p>
                </div>
                <LaneDispatchPreview lane={lane} automationQuery={automations} />
                {lane.cards.map((card) => (
                  <article key={card.id} className="min-w-0 overflow-hidden rounded-md border p-2 text-xs" data-testid={`card-${card.id}`}>
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-1">
                      <span className="min-w-0 flex-1 break-all font-mono">{card.id}</span>
                      <select
                        aria-label={`Priority for ${card.id}`}
                        className="w-20 max-w-full shrink-0 rounded border bg-background px-1 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        value={card.basePriority}
                        onChange={(e) => edit.mutate({ number: Number(card.id.split('#')[1]), expectedRevision: revisions[card.id] ?? 1, fields: { basePriority: e.target.value } })}
                      >
                        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <p className={statusTone(card.status.kind)} title={card.status.detail}>{cardStatusText(card)}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {card.badges.map((b) => <Badge key={b} variant="secondary">{b}</Badge>)}
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-muted-foreground">{card.topFactors.map((f) => `${f.name} ${f.points}`).join(' · ')}</span>
                      <Button variant="ghost" size="sm" aria-label={`Undo last change to ${card.id}`}
                        onClick={() => edit.mutate({ number: Number(card.id.split('#')[1]), expectedRevision: revisions[card.id] ?? 1, action: 'undo', fields: {} })}>
                        <Undo2Icon className="size-3" />
                      </Button>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
          <section aria-label="Conflicts and merge debt" className="rounded-md border p-3 text-sm">
            <h2 className="font-medium">Merge debt: {view.mergeDebt.open} open ({view.mergeDebt.needsAgent} need an integration agent)</h2>
            <ul className="list-disc pl-5">
              {view.mergeDebt.items.map((i) => <li key={i.key}>{i.issues.join(' ↔ ')} — {i.state}{i.githubIssue ? ` (#${i.githubIssue})` : ''}</li>)}
              {view.edges.filter((e) => e.source === 'decision').map((e) => <li key={`${e.from}-${e.to}`}>{e.from} ↔ {e.to} — {e.level} overlap</li>)}
            </ul>
          </section>
          <section aria-label="Override audit" className="rounded-md border p-3 text-sm">
            <h2 className="font-medium">Recent human changes</h2>
            <ul className="list-disc pl-5">
              {view.overrideAudit.slice(0, 20).map((a, i) => <li key={`${a.id}-${a.at}-${i}`}>{a.at} {a.actor} changed {a.changed.join(', ')} on {a.id}{a.reason ? ` — ${a.reason}` : ''}</li>)}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
