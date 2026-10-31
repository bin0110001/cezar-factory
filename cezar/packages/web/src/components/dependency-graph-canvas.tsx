import { useMemo, useState } from 'react'
import type { DependencyNeighborhood } from '@/api/client'

type Node = DependencyNeighborhood['nodes'][number]

/** A bounded, keyboard-operable graph canvas. The API supplies at most 200 nodes and 800 edges. */
export function DependencyGraphCanvas({ graph, onExpand }: { graph: DependencyNeighborhood; onExpand: (nodeId: string) => void }) {
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const layout = useMemo(() => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    const levels = new Map<string, number>([[graph.rootId, 0]])
    const queue = [graph.rootId]
    while (queue.length) {
      const id = queue.shift()!
      const level = levels.get(id)!
      for (const edge of graph.edges) {
        const neighbor = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined
        if (!neighbor || !byId.has(neighbor) || levels.has(neighbor)) continue
        levels.set(neighbor, Math.max(-2, Math.min(2, level + (edge.to === id ? -1 : 1))))
        queue.push(neighbor)
      }
    }
    const columns = new Map<number, Node[]>()
    for (const node of graph.nodes) {
      const level = levels.get(node.id) ?? 0
      const nodes = columns.get(level) ?? []
      nodes.push(node); columns.set(level, nodes)
    }
    for (const nodes of columns.values()) nodes.sort((a, b) => a.id.localeCompare(b.id))
    const positions = new Map<string, { x: number; y: number }>()
    for (const [level, nodes] of columns) nodes.forEach((node, index) => positions.set(node.id, { x: 450 + level * 240, y: 80 + index * 110 }))
    return { positions, byId, height: Math.max(420, ...[...columns.values()].map((nodes) => nodes.length * 110 + 80)) }
  }, [graph])
  const point = (node: Node) => layout.positions.get(node.id)!

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-3"><span>Drag to pan · use the slider to zoom · select a node to expand</span><span className="text-red-600">BLOCKS</span><span className="text-blue-600">PART_OF</span><span>Other relations</span></div>
      <label className="flex items-center gap-2">Zoom<input aria-label="Graph zoom" type="range" min="0.5" max="1.8" step="0.1" value={scale} onChange={(event) => setScale(Number(event.target.value))} /></label>
    </div>
    <svg
      role="group"
      aria-label={`Dependency graph neighborhood with ${graph.nodes.length} nodes and ${graph.edges.length} edges`}
      viewBox={`0 0 900 ${layout.height}`}
      className="max-h-[70vh] min-h-[360px] w-full touch-none rounded-lg border bg-background"
      onPointerDown={(event) => { if (!(event.target as Element).closest('[role="button"]')) { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }) } }}
      onPointerMove={(event) => { if (drag) setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y }) }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      <defs><marker id="dependency-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="currentColor" /></marker></defs>
      <g transform={`translate(${pan.x} ${pan.y}) translate(450 ${layout.height / 2}) scale(${scale}) translate(-450 ${layout.height / 2})`}>
        {graph.edges.map((edge) => {
          const from = layout.positions.get(edge.from); const to = layout.positions.get(edge.to)
          if (!from || !to) return null
          const color = edge.kind === 'BLOCKS' ? 'var(--destructive)' : edge.kind === 'PART_OF' ? 'var(--primary)' : 'var(--muted-foreground)'
          return <g key={edge.id} className="text-muted-foreground"><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth="2" markerEnd="url(#dependency-arrow)" /><text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6} textAnchor="middle" fontSize="11" fill={color}>{edge.kind}</text></g>
        })}
        {graph.nodes.map((node) => {
          const { x, y } = point(node); const selected = node.id === graph.rootId
          return <g key={node.id} role="button" tabIndex={0} aria-label={`${node.kind}: ${node.title}. Press Enter to expand neighborhood.`} onClick={() => onExpand(node.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onExpand(node.id) } }} className="cursor-pointer outline-none">
            <rect x={x - 90} y={y - 32} width="180" height="64" rx="10" fill="var(--background)" stroke={selected ? 'var(--primary)' : 'var(--muted-foreground)'} strokeWidth={selected ? 3 : 1.5} />
            <text x={x} y={y - 4} textAnchor="middle" fontSize="12" fontWeight="600" fill="currentColor">{node.title.slice(0, 24)}{node.title.length > 24 ? '…' : ''}</text>
            <text x={x} y={y + 16} textAnchor="middle" fontSize="10" fill="var(--muted-foreground)">{node.kind} · {node.state}</text>
          </g>
        })}
      </g>
    </svg>
    {graph.truncated && <p className="text-xs text-pending-strong">This neighborhood reached its safety limit. Expand a node to inspect that area.</p>}
  </div>
}
