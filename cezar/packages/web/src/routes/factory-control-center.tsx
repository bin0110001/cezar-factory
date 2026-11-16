import { AlertCircleIcon, RefreshCwIcon } from 'lucide-react'
import { Link } from 'react-router'
import { useState } from 'react'
import { useCandidateAction, useFactoryControlCenter } from '@/api/queries'
import { Button } from '@/components/ui/button'

const CHANNELS = ['dev', 'stable'] as const
const STATE_LABELS = {
  candidate: 'Candidate', eligible: 'Eligible', activating: 'Activating',
  healthy: 'Healthy', quarantined: 'Quarantined', unknown: 'Unknown',
} as const

function shortSha(sha: string | null) { return sha ? sha.slice(0, 12) : 'Unknown' }
function stamp(value: string | null) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

const ACTIONS = ['create', 'pause', 'resume', 'cancel', 'abandon', 'retry'] as const
const DESTRUCTIVE = new Set<string>(['cancel', 'abandon'])

/** Operator controls: only calls the server endpoint (which delegates to the lifecycle state machine) and re-reads. */
function CandidateActions({ projectId }: { projectId: string }) {
  const mutation = useCandidateAction()
  const [action, setAction] = useState<(typeof ACTIONS)[number]>('pause')
  const [candidateId, setCandidateId] = useState('')
  const [sourceSha, setSourceSha] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const destructive = DESTRUCTIVE.has(action)
  const phrase = `${action} ${candidateId}`
  const ready = action === 'create' ? sourceSha.length >= 40 : candidateId.length > 0 && (!destructive || confirmation === phrase)
  return <form className="mt-3 space-y-2 rounded-md border p-3" aria-label={`${projectId} candidate actions`} onSubmit={(event) => {
    event.preventDefault()
    mutation.mutate({ projectId, action, ...(action === 'create' ? { sourceSha } : { candidateId }), ...(destructive ? { confirmation } : {}) })
  }}>
    <h4 className="text-sm font-semibold">Candidate actions</h4>
    <div className="flex flex-wrap gap-2 text-sm">
      <select aria-label="Action" className="rounded border bg-background px-2 py-1" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>{ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}</select>
      {action === 'create'
        ? <input aria-label="Source commit" className="min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono" placeholder="Source commit SHA" value={sourceSha} onChange={(e) => setSourceSha(e.target.value.trim())} />
        : <input aria-label="Candidate id" className="min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono" placeholder="Candidate id" value={candidateId} onChange={(e) => setCandidateId(e.target.value.trim())} />}
    </div>
    {destructive && <label className="block text-xs">Type <code>{phrase}</code> to confirm<input aria-label="Typed confirmation" className="mt-1 block w-full rounded border bg-background px-2 py-1 font-mono" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>}
    <Button type="submit" size="sm" variant={destructive ? 'destructive' : 'outline'} disabled={!ready || mutation.isPending}>Run {action}</Button>
    {mutation.data && <p role="status" className="text-xs">{mutation.data.outcome}: {mutation.data.message}</p>}
    {mutation.isError && <p role="alert" className="text-xs text-destructive">{mutation.error.message}</p>}
  </form>
}

export function FactoryControlCenterRoute() {
  const query = useFactoryControlCenter()
  const projects = query.data?.projects ?? []
  const events = projects.flatMap((project) => project.history.map((event) => ({ ...event, projectId: project.id, projectName: project.name })))
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt)).slice(0, 20)

  return <main className="mx-auto w-full max-w-[1440px] space-y-6 p-4 md:px-8 md:py-7" data-testid="factory-control-center">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Factory Control Center</h1>
        <p className="mt-1 text-sm text-muted-foreground">Release channels, activation evidence, and project drift across this workspace.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCwIcon className="size-4" /> Refresh</Button>
    </header>

    {query.isPending && <p role="status" className="rounded-lg border p-5 text-sm text-muted-foreground">Loading release records…</p>}
    {query.isError && <section role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"><AlertCircleIcon className="mr-2 inline size-4" />Control Center data is unavailable: {query.error.message}</section>}

    {query.data && <>
      <section aria-labelledby="channel-summary-heading" className="space-y-3">
        <div><h2 id="channel-summary-heading" className="font-semibold">Release channels</h2><p className="text-xs text-muted-foreground">State comes from the configured channel pointer and its latest activation receipt.</p></div>
        <div className="grid gap-3 sm:grid-cols-2">
          {CHANNELS.map((channel) => {
            const rows = projects.map((project) => ({ project, record: project.channels.find((item) => item.channel === channel) }))
            const healthy = rows.filter(({ record }) => record?.state === 'healthy').length
            return <section className="rounded-lg border p-4" key={channel} aria-label={`${channel} channel summary`}>
              <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">{channel}</h3><span className="text-xs text-muted-foreground">{healthy} / {rows.length} healthy</span></div>
              <p className="mt-1 text-sm text-muted-foreground">{rows.filter(({ record }) => record?.state === 'activating').length} activating · {rows.filter(({ record }) => record?.state === 'quarantined').length} quarantined · {rows.filter(({ record }) => !record || record.state === 'unknown').length} unknown</p>
              {rows.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No registered projects.</p>}
            </section>
          })}
        </div>
      </section>

      <section aria-labelledby="projects-heading" className="space-y-3">
        <div><h2 id="projects-heading" className="font-semibold">Projects and release state</h2><p className="text-xs text-muted-foreground">Freshness is unknown when the release pointer or observation evidence is missing.</p></div>
        {projects.length === 0 ? <p className="rounded-lg border p-5 text-sm text-muted-foreground">No registered projects are available in this workspace.</p> : <div className="grid gap-3 xl:grid-cols-2">
          {projects.map((project) => <article key={project.id} className="min-w-0 rounded-lg border p-4">
            <header className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{project.name}</h3><p className="font-mono text-xs text-muted-foreground">{project.id}</p></div><span className="rounded-full border px-2 py-1 text-xs">{project.freshness === 'fresh' ? 'Fresh read' : project.freshness === 'stale' ? 'Stale' : 'Freshness unknown'}</span></header>
            <p className="mt-3 text-sm">Configured channel: <span className="font-medium">{project.configuredChannel ?? 'Unknown'}</span> · Compatibility: <span className="font-medium">{project.compatibility}</span></p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {project.channels.map((channel) => <section className="rounded-md bg-muted/30 p-3" key={channel.channel} aria-label={`${project.name} ${channel.channel} release`}>
                <div className="flex justify-between gap-2"><h4 className="text-sm font-semibold">{channel.channel}</h4><span className="text-xs">{STATE_LABELS[channel.state]}</span></div>
                <dl className="mt-2 space-y-1 text-xs"><div className="flex justify-between gap-2"><dt>Desired</dt><dd className="font-mono">{shortSha(channel.desiredSha)}</dd></div><div className="flex justify-between gap-2"><dt>Activated</dt><dd className="font-mono">{shortSha(channel.activatedSha)}</dd></div><div className="flex justify-between gap-2"><dt>Observed</dt><dd className="font-mono">{shortSha(channel.observedSha)}</dd></div><div className="flex justify-between gap-2"><dt>Updated</dt><dd>{stamp(channel.updatedAt)}</dd></div></dl>
                <div className="mt-2 space-y-1 break-all text-[11px] text-muted-foreground">
                  <p>Manifest digest: {channel.manifestDigest ?? 'Unknown'}</p>
                  {channel.manifest ? <><p>Build {channel.manifest.buildId} · {channel.manifest.builder} · {channel.manifest.workflow}</p><p>Built {stamp(channel.manifest.completedAt)} · Cezar API {channel.manifest.cezarApi}</p><p>Local verification: passed · evidence {channel.manifest.verificationDigest}</p><p>Evidence reference: {channel.manifest.verificationEvidenceRef}</p><p>Required capabilities: {channel.manifest.requiredCapabilities.join(', ') || 'None'}</p></> : <p>Manifest and local validation evidence: Unknown</p>}
                </div>
              </section>)}
            </div>
            <CandidateActions projectId={project.id} />
            {project.findings.length > 0 && <p className="mt-3 rounded border border-amber-500/40 p-2 text-xs" role="note">Findings: {project.findings.join(', ')}</p>}
          </article>)}
        </div>}
      </section>

      <section aria-labelledby="promotion-queue-heading" className="rounded-lg border p-4">
        <h2 id="promotion-queue-heading" className="font-semibold">Candidate backlog</h2>
        <p className="mt-1 text-sm text-muted-foreground">Promotion eligibility and soak checkpoints come from the host scheduler records, which are not exposed by the project activation API. Queue state is unknown here.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {['Candidate', 'Eligible', 'Activating', 'Healthy', 'Quarantined'].map((state) => <div className="rounded bg-muted/30 p-3" key={state}><p className="text-xs text-muted-foreground">{state}</p><p className="mt-1 font-medium">Unknown</p></div>)}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Release validation and verification records are available in <Link className="underline underline-offset-4" to="/verification">Verification history</Link>.</p>
      </section>

      <section aria-labelledby="release-history-heading" className="space-y-3">
        <div><h2 id="release-history-heading" className="font-semibold">Recent activation events</h2><p className="text-xs text-muted-foreground">{events.length} events · updated {stamp(query.data.generatedAt)}</p></div>
        {events.length === 0 ? <p className="rounded-lg border p-5 text-sm text-muted-foreground">No activation receipts are available. Missing records stay unknown.</p> : <ol className="space-y-2">
          {events.map((event) => <li key={`${event.projectId}:${event.id}`} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-medium">{event.projectName} · {event.channel} · {event.state}</p><p className="mt-1 font-mono text-xs text-muted-foreground">Desired {shortSha(event.desiredSha)} · activated {shortSha(event.actualSha)} · observed {shortSha(event.observedSha)}</p></div><time className="text-xs text-muted-foreground" dateTime={event.requestedAt}>{stamp(event.requestedAt)}</time></div>
            <p className="mt-2 text-xs">Compatibility: {event.compatibility} · requested {stamp(event.requestedAt)} · staged {stamp(event.stagedAt)} · activated {stamp(event.activatedAt)} · observed {stamp(event.observedAt)}</p>
            {(event.reasonCode || event.message || event.logRef) && <p className="mt-2 break-words text-xs text-muted-foreground">{[event.reasonCode, event.message, event.logRef].filter(Boolean).join(' · ')}</p>}
          </li>)}
        </ol>}
      </section>
    </>}
    {query.data && <p className="text-xs text-muted-foreground">Snapshot generated {stamp(query.data.generatedAt)}. Unavailable or stale evidence never counts as healthy.</p>}
  </main>
}
