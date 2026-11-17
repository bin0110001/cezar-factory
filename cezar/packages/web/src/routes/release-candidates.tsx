import type { Candidate, ReleaseCandidatesResponse } from '@open-mercato/cezar-api-client'

/**
 * Release candidates inside the existing Control Center (#633): detail and timeline for each project's active candidate, the queue
 * (pending triggers, next attempt, stale lease or blocked state), and the check matrix. Read-only; actions are #634. Human approval
 * is visibly different from failure: awaiting approval is a waiting state, never styled or worded as an error.
 */

type Query = { data?: ReleaseCandidatesResponse; isPending?: boolean; isError?: boolean; error?: unknown }

export type StateKind = 'in-progress' | 'awaiting-approval' | 'failure' | 'done'

const FAILURE = new Set(['failed', 'abandoned', 'canceled'])
export function stateKind(state: Candidate['state']): StateKind {
  if (state === 'awaiting-approval') return 'awaiting-approval'
  if (FAILURE.has(state)) return 'failure'
  if (state === 'promoted') return 'done'
  return 'in-progress'
}

const STATE_LABEL: Record<Candidate['state'], string> = {
  requested: 'Requested', admitted: 'Admitted', snapshotting: 'Snapshotting', validating: 'Validating', 'repair-required': 'Repair required', revalidating: 'Revalidating',
  ready: 'Ready', 'awaiting-approval': 'Waiting for human approval', promoting: 'Promoting', activating: 'Activating', promoted: 'Promoted', abandoned: 'Abandoned', failed: 'Failed', canceled: 'Canceled',
}

const KIND_STYLE: Record<StateKind, string> = {
  'in-progress': 'bg-muted text-foreground',
  'awaiting-approval': 'border-sky-500/50 bg-sky-500/10 text-sky-900 dark:text-sky-200',
  failure: 'border-destructive/50 bg-destructive/10 text-destructive',
  done: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200',
}

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : 'None')
function stamp(value: string | null) {
  if (!value) return 'Not scheduled'
  const d = new Date(value)
  return Number.isNaN(d.valueOf()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}

export function CandidateCard({ projectId, candidate }: { projectId: string; candidate: Candidate }) {
  const kind = stateKind(candidate.state)
  const blocking = candidate.repairObligations.filter((o) => o.blocksStable && (o.state === 'pending' || o.state === 'conflict'))
  return <article className="min-w-0 rounded-lg border p-4" aria-label={`${projectId} candidate ${candidate.id}`} data-testid={`candidate-${candidate.id}`} data-kind={kind}>
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div><h4 className="font-semibold">{projectId}</h4><p className="font-mono text-xs text-muted-foreground">{candidate.id} · revision {candidate.revision}</p></div>
      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${KIND_STYLE[kind]}`} data-testid="candidate-state" data-kind={kind}>{STATE_LABEL[candidate.state]}</span>
    </header>
    {kind === 'awaiting-approval' && <p className="mt-2 rounded-md border border-sky-500/40 bg-sky-500/5 p-2 text-sm" role="status">Waiting for a person to approve this release. Nothing has failed.</p>}
    {kind === 'failure' && <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm" role="alert">This candidate ended as {candidate.state}.</p>}

    <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
      <div><dt className="text-xs text-muted-foreground">Source dev SHA</dt><dd className="font-mono">{short(candidate.devSha)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Stable baseline</dt><dd className="font-mono">{short(candidate.baseStableSha)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Candidate SHA</dt><dd className="font-mono">{short(candidate.candidateSha)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Config hash</dt><dd className="font-mono">{candidate.configHash.slice(7, 19)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Tests</dt><dd>{candidate.tests.status} · {candidate.tests.shards.passed}/{candidate.tests.shards.total} shards passed{candidate.tests.shards.failed > 0 ? ` · ${candidate.tests.shards.failed} failed` : ''}{candidate.tests.assetVersion ? ` · assets ${candidate.tests.assetVersion}` : ''}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Dev drift</dt><dd>{candidate.devDrift.commitsAhead} commit(s) ahead{candidate.devDrift.newestDevSha ? ` (${short(candidate.devDrift.newestDevSha)})` : ''}</dd></div>
    </dl>

    <section aria-label="Queue and lease" className="mt-3 rounded-md bg-muted/30 p-3 text-sm">
      <p>Pending triggers: <span className="font-medium">{candidate.pending.count}</span>{candidate.pending.triggers.length > 0 ? ` (${candidate.pending.triggers.join(', ')})` : ''}</p>
      {candidate.pending.coalescedReason && <p className="text-muted-foreground">Coalesced because: {candidate.pending.coalescedReason}</p>}
      <p>Next scheduled attempt: <span className="font-medium">{stamp(candidate.nextScheduledAttempt)}</span></p>
      <p>Lease: {candidate.lease.owner ?? 'no owner'}{candidate.lease.stale ? <span className="ml-2 font-medium text-amber-700 dark:text-amber-300" data-testid="stale-lease">stale lease: the owner may have crashed</span> : ''}</p>
    </section>

    {candidate.blockers.length > 0 && <section aria-label="Blockers" className="mt-3"><h5 className="text-sm font-medium">Blockers</h5><ul className="mt-1 list-disc pl-5 text-sm">{candidate.blockers.map((b) => <li key={b.code}><span className="font-mono text-xs">{b.code}</span> {b.message}</li>)}</ul></section>}
    {blocking.length > 0 && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300" data-testid="forward-port-blocker">{blocking.length} unresolved forward-port obligation(s) block stable promotion.</p>}
    {candidate.receipts.length > 0 && <section aria-label="Promotion receipts" className="mt-3"><h5 className="text-sm font-medium">Receipts</h5><ul className="mt-1 text-sm">{candidate.receipts.map((r) => <li key={r.id}>{r.kind} · {r.ok ? 'ok' : 'failed'} · {stamp(r.at)}</li>)}</ul></section>}

    {candidate.checkMatrix.length > 0 && <section aria-label="Check matrix" className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-xs"><caption className="sr-only">Check results for this candidate</caption>
        <thead><tr className="text-muted-foreground"><th className="pr-3">Check</th><th className="pr-3">Result</th><th className="pr-3">Gate</th><th className="pr-3">New / known</th><th className="pr-3">Feed</th><th className="pr-3">Waivers</th></tr></thead>
        <tbody>{candidate.checkMatrix.map((r) => <tr key={r.category} data-testid={`check-${r.category}`}>
          <td className="pr-3 font-medium">{r.category}{r.provider ? <span className="ml-1 text-muted-foreground">{r.provider.name} {r.provider.version}</span> : null}</td>
          <td className="pr-3">{r.status}</td><td className="pr-3">{r.blocking ? 'Blocking' : 'Advisory'}</td><td className="pr-3">{r.newFindings} / {r.knownFindings}</td>
          <td className="pr-3">{r.feed}</td><td className="pr-3">{r.activeWaivers}</td></tr>)}</tbody></table>
    </section>}

    {(candidate.links.pullRequests.length > 0 || candidate.links.issues.length > 0) && <p className="mt-3 text-xs text-muted-foreground">Linked: {[...candidate.links.pullRequests.map((n) => `PR #${n}`), ...candidate.links.issues.map((n) => `issue #${n}`)].join(', ')}</p>}
    {candidate.warnings.length > 0 && <ul className="mt-3 space-y-1 text-sm" aria-label="Candidate warnings">{candidate.warnings.map((w, i) => <li key={`${w.kind}-${i}`} className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2"><span className="font-medium">{w.kind}:</span> {w.message}</li>)}</ul>}
  </article>
}

export function ReleaseCandidatesSection({ query }: { query: Query }) {
  return <section aria-labelledby="release-candidates-heading" className="space-y-3" data-testid="release-candidates">
    <div><h2 id="release-candidates-heading" className="font-semibold">Release candidates</h2>
      <p className="text-xs text-muted-foreground">One active candidate per project. The release engine writes this snapshot; this view only reads it.</p></div>
    {query.isPending && <p role="status" className="rounded-lg border p-4 text-sm text-muted-foreground">Loading release candidates…</p>}
    {query.isError && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">Release candidates could not be loaded: {query.error instanceof Error ? query.error.message : 'unknown error'}</p>}
    {query.data && !query.data.available && <p className="rounded-lg border p-4 text-sm text-muted-foreground">The release engine has not published a candidate snapshot yet. No candidate is active.</p>}
    {query.data?.available && query.data.projects.length === 0 && <p className="rounded-lg border p-4 text-sm text-muted-foreground">No projects have candidates.</p>}
    {query.data?.available && <div className="grid gap-3 lg:grid-cols-2">
      {query.data.projects.map((p) => <div key={p.projectId} className="space-y-2">
        {p.warnings.map((w) => <p key={w} className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm" role="alert">{w}</p>)}
        {p.active ? <CandidateCard projectId={p.projectId} candidate={p.active} /> : <p className="rounded-lg border p-4 text-sm text-muted-foreground" data-testid={`no-active-${p.projectId}`}>{p.projectId}: no active candidate.{p.history[0] ? ` Last: ${STATE_LABEL[p.history[0].state]}.` : ''}</p>}
      </div>)}
    </div>}
  </section>
}
