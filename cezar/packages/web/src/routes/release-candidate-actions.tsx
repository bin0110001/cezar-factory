import { useState, type FormEvent } from 'react'
import type { Candidate, CandidateActionRequest, CandidateActionResponse } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'

/**
 * Operator actions on a release candidate (#634): create, pause, resume, cancel, abandon, retry. Each action needs a reason, and the
 * destructive ones (cancel, abandon) need the candidate id typed to confirm. The view only requests: the service validates against the snapshot
 * and queues an audited request, and the candidate changes state only when the release engine applies it. Refusals (remote cockpit, wrong
 * state) are shown as returned.
 */

const TERMINAL = new Set<Candidate['state']>(['promoted', 'abandoned', 'failed', 'canceled'])
type Action = CandidateActionRequest['action']
const LABEL: Record<Action, string> = { create: 'Start a candidate', pause: 'Pause', resume: 'Resume', cancel: 'Cancel', abandon: 'Abandon', retry: 'Retry' }
const DESTRUCTIVE = new Set<Action>(['cancel', 'abandon'])

/** The actions worth offering for the current state; the service still validates each one. */
export function offeredActions(active: Candidate | null, lastState: Candidate['state'] | null): Action[] {
  if (!active || TERMINAL.has(active.state)) return lastState === 'failed' ? ['create', 'retry'] : ['create']
  return [...(active.state === 'repair-required' ? (['retry'] as const) : []), 'pause', 'resume', 'cancel', 'abandon']
}

export function CandidateActions({ projectId, active, lastState, send }: {
  projectId: string
  active: Candidate | null
  lastState: Candidate['state'] | null
  send: (req: CandidateActionRequest) => Promise<CandidateActionResponse>
}) {
  const [action, setAction] = useState<Action | null>(null)
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState('')
  const [state, setState] = useState<{ pending: boolean; error?: string; done?: string }>({ pending: false })
  const target = active && !TERMINAL.has(active.state) ? active : null
  const destructive = action !== null && DESTRUCTIVE.has(action)
  const ready = action !== null && reason.trim().length >= 3 && (!destructive || confirm === target?.id)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!action || !ready) return
    setState({ pending: true })
    const req: CandidateActionRequest = { action, projectId, reason: reason.trim(), ...(action !== 'create' && target ? { candidateId: target.id } : {}), ...(destructive ? { confirm } : {}) }
    try {
      const r = await send(req)
      setState({ pending: false, done: r.message })
      setAction(null); setReason(''); setConfirm('')
    } catch (err) { setState({ pending: false, error: err instanceof Error ? err.message : 'The request failed.' }) }
  }

  return <section aria-label={`${projectId} candidate actions`} className="mt-3 rounded-md border p-3" data-testid={`actions-${projectId}`}>
    <div className="flex flex-wrap gap-2">{offeredActions(active, lastState).map((a) =>
      <Button key={a} size="sm" variant={DESTRUCTIVE.has(a) ? 'danger-ghost' : 'outline'} onClick={() => { setAction(a); setState({ pending: false }) }} aria-pressed={action === a}>{LABEL[a]}</Button>)}</div>
    {action && <form className="mt-2 space-y-2" onSubmit={(e) => void submit(e)} aria-label={`${LABEL[action]} ${projectId}`}>
      <label className="block text-xs text-muted-foreground" htmlFor={`reason-${projectId}`}>Reason (recorded in the audit log)</label>
      <input id={`reason-${projectId}`} className="w-full rounded border bg-background px-2 py-1 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
      {destructive && target && <>
        <label className="block text-xs text-muted-foreground" htmlFor={`confirm-${projectId}`}>{LABEL[action]} is destructive: type {target.id} to confirm</label>
        <input id={`confirm-${projectId}`} className="w-full rounded border bg-background px-2 py-1 font-mono text-sm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </>}
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={!ready || state.pending}>Request {LABEL[action].toLowerCase()}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setAction(null)}>Close</Button></div>
    </form>}
    {state.error && <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>}
    {state.done && <p role="status" className="mt-2 text-sm">Queued for the release engine. {state.done}</p>}
    <p className="mt-2 text-xs text-muted-foreground">Local machine only. The candidate changes state only when the release engine applies the request.</p>
  </section>
}
