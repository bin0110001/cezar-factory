import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangleIcon, CheckCircle2Icon, HourglassIcon, RefreshCwIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getDependencyStalls, type StallClass, type StallItem, type StallReport } from '@/api/client'

const CLASS_LABEL: Record<StallClass, string> = { running: 'Running', runnable: 'Runnable', blocked: 'Blocked by progressing work', waiting: 'Waiting on input', stuck: 'Stuck' }
const CLASS_STROKE: Record<StallClass, string> = {
  running: 'var(--primary)', runnable: '#059669', blocked: 'var(--muted-foreground)', waiting: '#d97706', stuck: 'var(--destructive)',
}
const REASON_LABEL: Record<string, string> = {
  'dependency-cycle': 'dependency cycle', 'blocked-by-stuck': 'blocked by stuck work', 'stale-blocked-label': 'blocked label with no blocker',
  'no-consumer': 'no enabled automation', 'no-state-label': 'no state label', 'waiting-on-human': 'waiting on a person',
  'waiting-on-decision': 'waiting on a decision', 'waiting-on-external': 'waiting on outside information', 'blocked-by-work': 'blocked by work in progress',
}
const NODE_W = 150
const NODE_H = 44
const COL_GAP = 210
const ROW_GAP = 62

const shortId = (id: string) => /:(\d+)$/.test(id) ? `#${id.split(':').pop()}` : id.split(':').slice(0, 1)[0] + ' ' + (id.split(':').pop() ?? '')

/** Layered left-to-right layout: blockers sit left of what they block. Cycle edges are ignored for depth so loops cannot inflate it. */
export function layoutDependencyMap(report: Pick<StallReport, 'items' | 'cycles'>) {
  const cyclic = new Set(report.cycles.flat())
  const known = new Set(report.items.map((item) => item.nodeId))
  const nodes = new Map<string, { id: string; label: string; cls: StallClass | 'external'; title: string }>()
  const edges: Array<{ from: string; to: string; cycle: boolean }> = []
  for (const item of report.items) {
    for (const blocker of item.blockerIds) {
      edges.push({ from: blocker, to: item.nodeId, cycle: cyclic.has(blocker) && cyclic.has(item.nodeId) })
      if (!known.has(blocker)) nodes.set(blocker, { id: blocker, label: shortId(blocker), cls: 'external', title: blocker })
    }
  }
  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]))
  for (const item of report.items) if (connected.has(item.nodeId) || item.class === 'stuck' || item.class === 'waiting') nodes.set(item.nodeId, { id: item.nodeId, label: `#${item.number}`, cls: item.class, title: item.title })
  const depth = new Map<string, number>()
  const incoming = new Map<string, string[]>()
  for (const edge of edges) if (!edge.cycle) (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)!).push(edge.from)
  // Longest path by repeated relaxation; bounded by the node count so it always terminates.
  for (const id of nodes.keys()) depth.set(id, 0)
  for (let pass = 0; pass < nodes.size; pass += 1) {
    let changed = false
    for (const [to, froms] of incoming) {
      const want = Math.max(...froms.map((from) => (depth.get(from) ?? 0) + 1))
      if (want > (depth.get(to) ?? 0)) { depth.set(to, want); changed = true }
    }
    if (!changed) break
  }
  const columns = new Map<number, string[]>()
  for (const id of [...nodes.keys()].sort()) (columns.get(depth.get(id) ?? 0) ?? columns.set(depth.get(id) ?? 0, []).get(depth.get(id) ?? 0)!).push(id)
  const positions = new Map<string, { x: number; y: number }>()
  let rows = 1
  for (const [level, ids] of columns) { ids.forEach((id, index) => positions.set(id, { x: 20 + level * COL_GAP, y: 20 + index * ROW_GAP })); rows = Math.max(rows, ids.length) }
  const levels = Math.max(0, ...columns.keys()) + 1
  return { nodes, edges: edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to)), positions, width: 40 + levels * COL_GAP, height: 40 + rows * ROW_GAP }
}

function VerdictBanner({ report }: { report: StallReport }) {
  const stuck = report.counts.stuck
  if (report.verdict === 'stalled') return <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive"><AlertTriangleIcon className="mr-1 inline size-4" /><strong>Work is stalled.</strong> {report.summary} Repair is dispatched automatically; see the stuck rows below.</p>
  if (stuck > 0) return <p role="alert" className="rounded-md border border-destructive/60 p-3 text-sm"><AlertTriangleIcon className="mr-1 inline size-4 text-destructive" />{report.summary}</p>
  if (report.verdict === 'waiting') return <p className="rounded-md border p-3 text-sm"><HourglassIcon className="mr-1 inline size-4" />{report.summary} This is an acceptable stopping point.</p>
  if (report.verdict === 'unknown') return <p className="rounded-md border p-3 text-sm text-muted-foreground">{report.summary}</p>
  return <p className="rounded-md border p-3 text-sm"><CheckCircle2Icon className="mr-1 inline size-4 text-emerald-600" />{report.summary}</p>
}

function BlockerList({ item }: { item: StallItem }) {
  if (item.blockerIds.length === 0) return <span className="text-muted-foreground">none</span>
  return <span className="font-mono">{item.blockerIds.map(shortId).join(', ')}</span>
}

/** Every open task, what blocks it, and whether anything can still move. Backed by `/dependency-graph/stalls`. */
export function BacklogDependencyMap() {
  const stalls = useQuery({ queryKey: ['dependency-graph', 'stalls'], queryFn: () => getDependencyStalls(), staleTime: 15_000 })
  const report = stalls.data
  const layout = useMemo(() => report ? layoutDependencyMap(report) : undefined, [report])
  if (stalls.isError) return <p role="alert" className="text-sm text-destructive">Dependency map is unavailable: {(stalls.error as Error).message}</p>
  if (!report || !layout) return <p className="text-sm text-muted-foreground">Loading dependency map…</p>
  return (
    <div className="flex flex-col gap-3" data-testid="backlog-dependency-map">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1"><VerdictBanner report={report} /></div>
        <Button variant="outline" size="sm" onClick={() => void stalls.refetch()}><RefreshCwIcon className="size-4" /> Refresh</Button>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {(Object.keys(CLASS_LABEL) as StallClass[]).map((cls) => <span key={cls} className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-full" style={{ background: CLASS_STROKE[cls] }} />{CLASS_LABEL[cls]} ({report.counts[cls]})</span>)}
      </div>
      {report.cycles.length > 0 && (
        <section aria-label="Dependency cycles" className="rounded-md border border-destructive/60 p-3 text-sm">
          <h2 className="font-medium">Dependency cycles ({report.cycles.length})</h2>
          <ul className="list-disc pl-5">{report.cycles.map((cycle) => <li key={cycle.join('|')} className="font-mono">{cycle.map(shortId).join(' ⇄ ')}</li>)}</ul>
        </section>
      )}
      {layout.nodes.size > 0
        ? <div className="overflow-auto rounded-lg border bg-background">
          <svg role="group" aria-label={`Dependency map with ${layout.nodes.size} nodes and ${layout.edges.length} blocking edges`} width={layout.width} height={layout.height} className="min-w-full">
            <defs><marker id="map-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="currentColor" /></marker></defs>
            {layout.edges.map((edge) => {
              const from = layout.positions.get(edge.from)!; const to = layout.positions.get(edge.to)!
              return <line key={`${edge.from}>${edge.to}`} x1={from.x + NODE_W} y1={from.y + NODE_H / 2} x2={to.x} y2={to.y + NODE_H / 2} className="text-muted-foreground" stroke={edge.cycle ? 'var(--destructive)' : 'currentColor'} strokeDasharray={edge.cycle ? '5 3' : undefined} strokeWidth="1.5" markerEnd="url(#map-arrow)" />
            })}
            {[...layout.nodes.values()].map((node) => {
              const at = layout.positions.get(node.id)!
              const stroke = node.cls === 'external' ? 'var(--muted-foreground)' : CLASS_STROKE[node.cls]
              return <g key={node.id} aria-label={`${node.label} ${node.cls}: ${node.title}`}>
                <title>{node.title}</title>
                <rect x={at.x} y={at.y} width={NODE_W} height={NODE_H} rx="8" fill="var(--background)" stroke={stroke} strokeWidth={node.cls === 'stuck' ? 3 : 1.5} strokeDasharray={node.cls === 'external' ? '4 3' : undefined} />
                <text x={at.x + 8} y={at.y + 18} fontSize="12" fontWeight="600" fill="currentColor">{node.label}</text>
                <text x={at.x + 8} y={at.y + 34} fontSize="10" fill="var(--muted-foreground)">{node.cls === 'external' ? 'decision / external' : node.title.slice(0, 22)}{node.title.length > 22 && node.cls !== 'external' ? '…' : ''}</text>
              </g>
            })}
          </svg>
        </div>
        : <p className="text-sm text-muted-foreground">No issue has a dependency yet.</p>}
      <section aria-label="Blockers by issue" className="overflow-x-auto rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/40"><tr><th className="p-2">Issue</th><th className="p-2">State</th><th className="p-2">Why</th><th className="p-2">Blocked by</th></tr></thead>
          <tbody>
            {report.items.map((item) => (
              <tr key={item.nodeId} className="border-t align-top" data-testid={`map-row-${item.number}`}>
                <td className="p-2"><span className="font-mono">#{item.number}</span> {item.title}</td>
                <td className="p-2"><Badge variant={item.class === 'stuck' ? 'destructive' : 'secondary'}>{CLASS_LABEL[item.class]}</Badge></td>
                <td className="p-2">{item.reason ? `${REASON_LABEL[item.reason] ?? item.reason}: ` : ''}{item.detail}{item.class === 'stuck' && item.rootCauseIds.length > 0 && item.reason === 'blocked-by-stuck' ? ` (root: ${item.rootCauseIds.map(shortId).join(', ')})` : ''}</td>
                <td className="p-2"><BlockerList item={item} /></td>
              </tr>
            ))}
            {report.items.length === 0 && <tr><td colSpan={4} className="p-3 text-muted-foreground">No open work.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  )
}
