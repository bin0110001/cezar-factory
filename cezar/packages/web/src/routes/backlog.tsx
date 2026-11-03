import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { AlertTriangleIcon, RefreshCwIcon, Undo2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { editBacklogIssue, getBacklog, getBacklogRecommendation, type BacklogCardData } from '@/api/client'

const key = ['backlog'] as const
const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4', 'unset'] as const

function statusTone(kind: BacklogCardData['status']['kind']): string {
  if (kind === 'dispatchable' || kind === 'running') return 'text-emerald-600'
  if (kind === 'deferred') return 'text-pending-strong'
  return 'text-muted-foreground'
}

/** Backlog lanes with the scheduler's own reasons, conflict edges, merge debt and override audit (#201). */
export function BacklogRoute() {
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const overview = useQuery({ queryKey: key, queryFn: () => getBacklog(), staleTime: 15_000 })
  const recommendation = useQuery({ queryKey: [...key, 'recommendation'], queryFn: () => getBacklogRecommendation(5), staleTime: 15_000 })
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
        <Button variant="outline" size="sm" onClick={() => void client.invalidateQueries({ queryKey: key })}>
          <RefreshCwIcon className="size-4" /> Refresh
        </Button>
      </header>
      {error && <p role="alert" className="text-sm text-destructive"><AlertTriangleIcon className="mr-1 inline size-4" />{error}</p>}
      {overview.isError && <p role="alert" className="text-sm text-destructive">Backlog is unavailable: {(overview.error as Error).message}</p>}
      {recommendation.data && (
        <section aria-label="Next up" className="rounded-md border p-3 text-sm">
          <h2 className="font-medium">Next up</h2>
          {recommendation.data.next
            ? <p>{recommendation.data.next.id} — score {recommendation.data.next.score}; {recommendation.data.next.factors.slice(0, 3).map((f) => `${f.name} ${f.points}`).join(', ')}</p>
            : <p className="text-muted-foreground">Nothing is dispatchable right now.</p>}
          {recommendation.data.needsHuman.length > 0 && (
            <p className="mt-1 text-muted-foreground">Needs a human decision: {recommendation.data.needsHuman.map((n) => n.id).join(', ')}</p>
          )}
        </section>
      )}
      {view && (
        <>
          <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-7">
            {view.lanes.map((lane) => (
              <section key={lane.lane} aria-label={lane.lane} className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">{lane.lane} <span className="text-muted-foreground">({lane.cards.length})</span></h2>
                {lane.cards.map((card) => (
                  <article key={card.id} className="rounded-md border p-2 text-xs" data-testid={`card-${card.id}`}>
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono">{card.id}</span>
                      <select
                        aria-label={`Priority for ${card.id}`}
                        className="rounded border bg-background px-1 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        value={card.basePriority}
                        onChange={(e) => edit.mutate({ number: Number(card.id.split('#')[1]), expectedRevision: revisions[card.id] ?? 1, fields: { basePriority: e.target.value } })}
                      >
                        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <p className={statusTone(card.status.kind)} title={card.status.detail}>{card.status.reasonCode}: {card.status.detail}</p>
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
