import { useState, type FormEvent } from 'react'
import type { PipelinePolicyPreviewRequest, PipelinePolicyPreviewResponse, PipelinePolicySaveRequest, PipelinePolicySaveResponse } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'

/**
 * Release pipeline policy editor (#632). The operator edits one project's override as JSON, previews it (validation errors with paths, the
 * effective configuration hash and the next scheduled runs) and saves it with a reason. A save is refused when someone else changed the policy
 * since it was loaded, and applies to future candidates only: a candidate keeps the configuration it was bound to. Nothing is saved by a preview.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : 'The request failed.')

export function PipelinePolicyEditor({ projectIds, initial, preview, save }: {
  projectIds: readonly string[]
  /** The saved override and effective hash per project, from the policy document. */
  initial: Record<string, { policy: Record<string, unknown>; effectiveHash: string | null }>
  preview: (req: PipelinePolicyPreviewRequest) => Promise<PipelinePolicyPreviewResponse>
  save: (req: PipelinePolicySaveRequest) => Promise<PipelinePolicySaveResponse>
}) {
  const [projectId, setProjectId] = useState(projectIds[0] ?? '')
  const project = projectId || projectIds[0] || ''
  const [texts, setTexts] = useState<Record<string, string>>({})
  const text = texts[project] ?? JSON.stringify(initial[project]?.policy ?? {}, null, 2)
  const [reason, setReason] = useState('')
  const [pv, setPv] = useState<{ pending: boolean; error?: string; result?: PipelinePolicyPreviewResponse }>({ pending: false })
  const [sv, setSv] = useState<{ pending: boolean; error?: string; result?: PipelinePolicySaveResponse }>({ pending: false })

  const parse = (): Record<string, unknown> | null => {
    try { const v: unknown = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null } catch { return null }
  }
  const edit = (value: string) => { setTexts({ ...texts, [project]: value }); setPv({ pending: false }); setSv({ pending: false }) }

  async function runPreview(e: FormEvent) {
    e.preventDefault()
    const policy = parse()
    if (!policy) { setPv({ pending: false, error: 'The policy must be a JSON object.' }); return }
    setPv({ pending: true })
    try { setPv({ pending: false, result: await preview({ projectId: project, policy }) }) } catch (err) { setPv({ pending: false, error: message(err) }) }
  }

  async function runSave() {
    const policy = parse()
    if (!policy || !pv.result?.valid) return
    setSv({ pending: true })
    try { setSv({ pending: false, result: await save({ projectId: project, policy, reason: reason.trim(), expectedCurrentHash: initial[project]?.effectiveHash ?? null }) }) } catch (err) { setSv({ pending: false, error: message(err) }) }
  }

  const canSave = pv.result?.valid === true && reason.trim().length >= 3 && !sv.pending && !sv.result

  return <section aria-labelledby="policy-editor-heading" className="space-y-3" data-testid="policy-editor">
    <div><h2 id="policy-editor-heading" className="font-semibold">Release pipeline policy</h2>
      <p className="text-xs text-muted-foreground">Edit a project's override, preview it, then save with a reason. Saving applies to future candidates only; a candidate keeps the configuration it was bound to. Local machine only.</p></div>
    {projectIds.length === 0 ? <p className="rounded-lg border p-4 text-sm text-muted-foreground">No project to configure yet.</p> :
      <form className="space-y-2 rounded-lg border p-4" onSubmit={(e) => void runPreview(e)} aria-label="Pipeline policy editor">
        <label className="block text-sm">Project <select className="ml-2 rounded border bg-background px-2 py-1" value={project} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          {projectIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <label className="block text-xs text-muted-foreground" htmlFor="policy-json">Override (release-pipeline/v1 JSON)</label>
        <textarea id="policy-json" className="h-48 w-full rounded border bg-background p-2 font-mono text-xs" value={text} onChange={(e) => edit(e.target.value)} />
        <Button type="submit" size="sm" disabled={pv.pending}>Preview</Button>
        {pv.error && <p role="alert" className="text-sm text-destructive">{pv.error}</p>}
        {pv.result && !pv.result.valid && <ul role="alert" className="list-disc pl-5 text-sm text-destructive" data-testid="policy-errors">{pv.result.errors.map((er) => <li key={er}>{er}</li>)}</ul>}
        {pv.result?.valid && <div className="text-sm" data-testid="policy-preview">
          <p>Valid. Effective configuration <span className="font-mono">{pv.result.effectiveHash?.slice(7, 19)}</span>{pv.result.currentHash ? <> (saved today: <span className="font-mono">{pv.result.currentHash.slice(7, 19)}</span>)</> : ' (nothing saved yet)'}.</p>
          {pv.result.nextRuns.length > 0 ? <p>Next runs (UTC): {pv.result.nextRuns.slice(0, 5).map((r) => r.slice(0, 16).replace('T', ' ')).join(', ')}</p> : <p className="text-muted-foreground">No calendar schedule.</p>}
        </div>}
        {pv.result?.valid && <div className="space-y-2 border-t pt-2">
          <label className="block text-xs text-muted-foreground" htmlFor="policy-reason">Reason for the change (recorded in the audit log)</label>
          <input id="policy-reason" className="w-full rounded border bg-background px-2 py-1 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="button" size="sm" disabled={!canSave} onClick={() => void runSave()}>Save policy</Button>
        </div>}
        {sv.error && <p role="alert" className="text-sm text-destructive">{sv.error}</p>}
        {sv.result && <p role="status" className="text-sm">Saved ({sv.result.auditId}). It applies to future candidates only.</p>}
      </form>}
  </section>
}
