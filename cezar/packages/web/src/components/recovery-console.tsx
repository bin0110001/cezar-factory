import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import {
  ACTION_KINDS, aggregateIncidents, gateAction, newIdempotencyKey,
  type AggregatedIncident, type RecoveryActionKind, type RecoveryClient, type RecoveryReceipt, type RecoveryState,
} from '@/lib/recovery-contract'

const formatTime = (epoch: number | null) => (epoch === null ? 'none' : new Date(epoch * 1000).toISOString())

type Outcome = { action: RecoveryActionKind; receipt: RecoveryReceipt } | { action: RecoveryActionKind; error: string }

export function RecoveryConsole({ client, pollMs = 1000 }: { client: RecoveryClient; pollMs?: number }) {
  const [state, setState] = useState<RecoveryState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<RecoveryActionKind | null>(null)
  const [pending, setPending] = useState<RecoveryActionKind | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  // One key per user intent: reused if the same submit is retried after an error, so it is never run twice.
  const keyRef = useRef<{ id: string; key: string } | null>(null)

  const load = useCallback(async () => {
    try { setState(await client.load()); setLoadError(null) }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load incidents.') }
  }, [client])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (outcome) alertRef.current?.focus() }, [outcome])

  const incidents = state ? aggregateIncidents(state.incidents) : []
  const current: AggregatedIncident | undefined = incidents.find((i) => `${i.failureClass}:${i.fingerprint}` === selected)

  const submit = async (action: RecoveryActionKind, incident: AggregatedIncident) => {
    if (pending) return
    const intent = `${action}:${incident.failureClass}:${incident.fingerprint}`
    if (keyRef.current?.id !== intent) keyRef.current = { id: intent, key: newIdempotencyKey() }
    const idempotencyKey = keyRef.current.key
    setPending(action); setOutcome(null)
    try {
      let receipt = await client.submitAction({ action, failureClass: incident.failureClass, fingerprint: incident.fingerprint, idempotencyKey })
      // API acceptance is not success: keep polling until the backend receipt settles.
      while (receipt.state === 'pending') {
        await new Promise((r) => setTimeout(r, pollMs))
        receipt = await client.getReceipt(idempotencyKey)
      }
      if (receipt.state === 'succeeded') keyRef.current = null
      setOutcome({ action, receipt })
      await load()
    } catch (e) {
      setOutcome({ action, error: e instanceof Error ? e.message : 'The action failed.' })
    } finally { setPending(null) }
  }

  const request = (action: RecoveryActionKind) => {
    if (!current || !state) return
    const gate = gateAction(action, current, state)
    if (!gate.enabled || pending) return
    if (gate.needsConfirmation) setConfirming(action)
    else void submit(action, current)
  }

  if (loadError) return <div role="alert" className="p-6 text-sm text-destructive">{loadError} <Button size="sm" onClick={() => void load()}>Retry loading</Button></div>
  if (!state) return <div role="status" className="p-6 text-sm text-muted-foreground">Loading recovery incidents…</div>

  return (
    <section aria-labelledby="recovery-title" className="space-y-4 p-6">
      <h1 id="recovery-title" className="text-lg font-semibold">Recovery</h1>
      {state.conflict && <p role="status" data-testid="recovery-conflict" className="text-sm">Unsafe actions are disabled while {state.conflict.detail}</p>}
      <div ref={alertRef} tabIndex={-1} aria-live="assertive" role="alert" className="outline-none">
        {outcome && ('error' in outcome
          ? <p>{outcome.action} failed: {outcome.error}</p>
          : outcome.receipt.state === 'succeeded'
            ? <p>{outcome.action} succeeded (audit {outcome.receipt.auditId ?? 'recorded'}).</p>
            : <p>{outcome.action} failed: {outcome.receipt.message ?? 'the backend reported a failure.'}</p>)}
      </div>
      {pending && <p role="status">Running {pending}… waiting for the backend receipt.</p>}
      {incidents.length === 0 ? <p className="text-sm text-muted-foreground">No incidents recorded.</p> : (
        <ul aria-label="Incidents" className="space-y-1">
          {incidents.map((i) => {
            const id = `${i.failureClass}:${i.fingerprint}`
            return (
              <li key={id}>
                <button type="button" aria-pressed={selected === id} className="w-full text-left text-sm" onClick={() => { setSelected(id); setOutcome(null) }}>
                  <span className="font-mono">{i.fingerprint.slice(0, 12)}</span> {i.summary} — {i.failureClass} · {i.status} · attempts {i.attemptCount} · ×{i.occurrenceCount} · {i.severity} · cooldown {formatTime(i.nextAttemptAt)}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {current && (
        <article aria-label="Incident details" className="space-y-2 text-sm">
          <h2 className="font-medium">{current.summary}</h2>
          <dl className="grid grid-cols-[10rem_1fr] gap-1">
            <dt>Fingerprint</dt><dd className="font-mono">{current.fingerprint}</dd>
            <dt>Status</dt><dd>{current.status}</dd>
            <dt>Attempts</dt><dd>{current.attemptCount}</dd>
            <dt>Cooldown until</dt><dd>{formatTime(current.nextAttemptAt)}</dd>
            <dt>Affected projects</dt><dd>{current.affectedProjects.join(', ') || 'none'}</dd>
            <dt>Candidate</dt><dd className="font-mono">{current.candidateSha ?? 'none'}</dd>
            <dt>Error evidence</dt><dd>{Object.entries(current.causalEvidence).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none'}</dd>
            <dt>Prior repairs</dt><dd>{current.priorRepairs.map((r) => `${r.id} (${r.outcome})`).join(', ') || 'none'}</dd>
            <dt>Generated PR</dt><dd>{current.generatedPrUrl ? <a className="underline" href={current.generatedPrUrl}>{current.generatedPrUrl}</a> : 'none'}</dd>
          </dl>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Recovery actions">
            {ACTION_KINDS.map((action) => {
              const gate = gateAction(action, current, state)
              const reasonId = `reason-${action}`
              return (
                <span key={action} className="inline-flex flex-col">
                  <Button type="button" size="sm" disabled={!gate.enabled || pending !== null} aria-describedby={gate.reason ? reasonId : undefined} onClick={() => request(action)}>{action}</Button>
                  {gate.reason && <span id={reasonId} className="text-xs text-muted-foreground">{gate.reason}</span>}
                </span>
              )
            })}
          </div>
        </article>
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm {confirming}</AlertDialogTitle>
            <AlertDialogDescription>{confirming} is a high-risk action on incident {current?.fingerprint.slice(0, 12)}. It is audited and cannot be undone from this screen.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const a = confirming; setConfirming(null); if (a && current) void submit(a, current) }}>Confirm {confirming}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
