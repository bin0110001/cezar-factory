import { useState, type FormEvent } from 'react'
import type { QualityDryRunRequest, QualityDryRunResponse, WaiverRequest, WaiverResponse } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'

/**
 * Quality actions in the Control Center (#603). Both forms are requests only: the dry run saves nothing and a waiver request is audited and
 * queued for the release engine, never granted here. A required check with no result is shown as unknown (blocking), and a failed scan
 * (error) is shown apart from a confirmed finding (fail). Both actions are local-machine only; a refusal is shown as returned.
 */

const STAGES = ['pr-dev', 'candidate', 'stable', 'periodic', 'manual'] as const
type Stage = (typeof STAGES)[number]
const message = (e: unknown) => (e instanceof Error ? e.message : 'The request failed.')

export function QualityActionsSection({ projectIds, dryRun, requestWaiver }: {
  projectIds: readonly string[]
  dryRun: (req: QualityDryRunRequest) => Promise<QualityDryRunResponse>
  requestWaiver: (req: WaiverRequest) => Promise<WaiverResponse>
}) {
  const [projectId, setProjectId] = useState(projectIds[0] ?? '')
  const [policyText, setPolicyText] = useState('')
  const [dry, setDry] = useState<{ pending: boolean; error?: string; result?: QualityDryRunResponse }>({ pending: false })
  const [key, setKey] = useState('')
  const [stages, setStages] = useState<Stage[]>(['stable'])
  const [reason, setReason] = useState('')
  const [days, setDays] = useState(7)
  const [wv, setWv] = useState<{ pending: boolean; error?: string; result?: WaiverResponse }>({ pending: false })
  const project = projectId || projectIds[0] || ''

  async function runDry(e: FormEvent) {
    e.preventDefault()
    let policy: Record<string, unknown>
    try { const parsed: unknown = JSON.parse(policyText); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object'); policy = parsed as Record<string, unknown> } catch { setDry({ pending: false, error: 'The policy must be a JSON object (a quality-gates/v1 document).' }); return }
    setDry({ pending: true })
    try { setDry({ pending: false, result: await dryRun({ projectId: project, policy }) }) } catch (err) { setDry({ pending: false, error: message(err) }) }
  }

  async function submitWaiver(e: FormEvent) {
    e.preventDefault()
    const trimmed = key.trim()
    const req: WaiverRequest = { projectId: project, stages, reason: reason.trim(), expiresInDays: days, ...(/^[a-f0-9]{64}$/.test(trimmed) ? { fingerprint: trimmed } : { advisoryId: trimmed }) }
    setWv({ pending: true })
    try { setWv({ pending: false, result: await requestWaiver(req) }) } catch (err) { setWv({ pending: false, error: message(err) }) }
  }

  const toggle = (s: Stage) => setStages((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
  const canWaive = project !== '' && key.trim() !== '' && stages.length > 0 && reason.trim().length >= 10 && days >= 1 && days <= 365

  return <section aria-labelledby="quality-actions-heading" className="space-y-3" data-testid="quality-actions">
    <div><h2 id="quality-actions-heading" className="font-semibold">Quality actions</h2>
      <p className="text-xs text-muted-foreground">Local machine only. A dry run saves nothing. A waiver request names what it covers and expires; the release engine records it, this view never grants it.</p></div>
    {projectIds.length === 0 ? <p className="rounded-lg border p-4 text-sm text-muted-foreground">No project has published a candidate snapshot yet.</p> : <>
      <label className="block text-sm">Project <select className="ml-2 rounded border bg-background px-2 py-1" value={project} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
        {projectIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      <div className="grid gap-3 lg:grid-cols-2">
        <form className="space-y-2 rounded-lg border p-4" onSubmit={(e) => void runDry(e)} aria-label="Policy dry run">
          <h3 className="font-semibold">Policy dry run</h3>
          <label className="block text-xs text-muted-foreground" htmlFor="dry-policy">Policy (quality-gates/v1 JSON)</label>
          <textarea id="dry-policy" className="h-32 w-full rounded border bg-background p-2 font-mono text-xs" value={policyText} onChange={(e) => setPolicyText(e.target.value)} />
          <Button type="submit" size="sm" disabled={dry.pending || policyText.trim() === ''}>Run dry run</Button>
          {dry.error && <p role="alert" className="text-sm text-destructive">{dry.error}</p>}
          {dry.result && <DryRunResult result={dry.result} />}
        </form>
        <form className="space-y-2 rounded-lg border p-4" onSubmit={(e) => void submitWaiver(e)} aria-label="Waiver request">
          <h3 className="font-semibold">Waiver request</h3>
          <label className="block text-xs text-muted-foreground" htmlFor="waiver-key">Finding fingerprint (64 hex) or advisory id</label>
          <input id="waiver-key" className="w-full rounded border bg-background px-2 py-1 text-sm" value={key} onChange={(e) => setKey(e.target.value)} />
          <fieldset><legend className="text-xs text-muted-foreground">Stages covered</legend>
            <div className="flex flex-wrap gap-3 text-sm">{STAGES.map((s) => <label key={s}><input type="checkbox" checked={stages.includes(s)} onChange={() => toggle(s)} /> {s}</label>)}</div></fieldset>
          <label className="block text-xs text-muted-foreground" htmlFor="waiver-reason">Reason (at least 10 characters)</label>
          <textarea id="waiver-reason" className="h-16 w-full rounded border bg-background p-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
          <label className="block text-xs text-muted-foreground" htmlFor="waiver-days">Expires in days (1 to 365; the engine enforces the policy maximum)</label>
          <input id="waiver-days" type="number" min={1} max={365} className="w-24 rounded border bg-background px-2 py-1 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))} />
          <div><Button type="submit" size="sm" disabled={wv.pending || !canWaive}>Request waiver</Button></div>
          {wv.error && <p role="alert" className="text-sm text-destructive">{wv.error}</p>}
          {wv.result && <p role="status" className="text-sm">Queued for the release engine until {wv.result.expiresAt.slice(0, 10)} (request {wv.result.requestId}). {wv.result.message}</p>}
        </form>
      </div>
    </>}
  </section>
}

function DryRunResult({ result }: { result: QualityDryRunResponse }) {
  if (!result.valid) return <ul role="alert" className="list-disc pl-5 text-sm text-destructive" data-testid="dry-run-errors">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>
  return <div className="space-y-2" data-testid="dry-run-result">
    <p className="text-xs text-muted-foreground">{result.candidateId ? `Applied to candidate ${result.candidateId}.` : 'No candidate to apply it to.'} Estimated cost: {result.estimate.computeHours === null ? 'not recorded' : `${result.estimate.computeHours} h`} ({result.estimate.basis}).</p>
    {result.warnings.map((w) => <p key={w} className="text-xs text-amber-600">{w}</p>)}
    {result.stages.map((s) => <div key={s.stage} data-testid={`dry-stage-${s.stage}`}>
      <p className="text-sm font-medium">{s.stage}: {s.wouldBlock ? 'would block' : 'would not block'}</p>
      <ul className="text-xs">{s.checks.filter((c) => c.level !== 'off').map((c) => <li key={c.category}>{c.category} · {c.status} · {c.level}/{c.onUnavailable} · {c.blocks ? 'blocks' : 'does not block'} — {c.note}</li>)}</ul>
    </div>)}
  </div>
}
