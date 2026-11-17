import type { ReleaseHistoryResponse, ReleaseMetricsResponse } from '@open-mercato/cezar-api-client'

/**
 * Release metrics and history inside the existing Control Center (#635). Read-only. A figure the engine did not record shows as "not
 * recorded", never as zero or an estimate. History merges operator actions and policy changes (newest first) and respects each
 * project's retention; changing policy or running actions is done through the editor and the candidate controls, which are local-only.
 */

type Q<T> = { data?: T; isPending?: boolean; isError?: boolean; error?: unknown }

const val = (n: number | null, unit = '') => (n === null ? 'not recorded' : `${n}${unit}`)
function stamp(value: string) {
  const d = new Date(value)
  return Number.isNaN(d.valueOf()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}

export function ReleaseMetricsSection({ metrics, history }: { metrics: Q<ReleaseMetricsResponse>; history: Q<ReleaseHistoryResponse> }) {
  return <section aria-labelledby="release-metrics-heading" className="space-y-3" data-testid="release-metrics">
    <div><h2 id="release-metrics-heading" className="font-semibold">Release metrics and history</h2>
      <p className="text-xs text-muted-foreground">Computed from the candidate snapshot. Figures the release engine did not record show as not recorded. History respects each project's retention window.</p></div>
    {(metrics.isPending || history.isPending) && <p role="status" className="rounded-lg border p-4 text-sm text-muted-foreground">Loading release metrics…</p>}
    {(metrics.isError || history.isError) && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">Release metrics could not be loaded.</p>}
    {metrics.data && !metrics.data.available && <p className="rounded-lg border p-4 text-sm text-muted-foreground">No candidate snapshot has been published, so there are no metrics yet.</p>}
    {metrics.data?.available && <div className="grid gap-3 lg:grid-cols-2">
      {metrics.data.projects.map((p) => <article key={p.projectId} className="rounded-lg border p-4" aria-label={`${p.projectId} metrics`} data-testid={`metrics-${p.projectId}`}>
        <h3 className="font-semibold">{p.projectId}</h3>
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">Queue wait (mean / worst)</dt><dd>{val(p.queueWaitMinutes.mean, ' min')} / {val(p.queueWaitMinutes.max, ' min')}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Suite cost (total / mean)</dt><dd>{val(p.suiteCostHours.total, ' h')} / {val(p.suiteCostHours.mean, ' h')}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Regressions</dt><dd>{p.regressions.candidatesWithRepair} of {p.regressions.candidates} candidates needed repair</dd></div>
          <div><dt className="text-xs text-muted-foreground">Forward-port lag</dt><dd>{val(p.forwardPortLagHours.oldest, ' h')} oldest · {p.forwardPortLagHours.unresolved} unresolved</dd></div>
          <div><dt className="text-xs text-muted-foreground">Stable age</dt><dd>{val(p.stableAgeHours, ' h since last promotion')}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Scheduled checks</dt><dd>{p.scheduledChecks.runs} runs · {p.scheduledChecks.failing} failing{p.scheduledChecks.lastRanAt ? ` · last ${stamp(p.scheduledChecks.lastRanAt)}` : ''}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">AI audit (opt-in)</dt><dd>{p.aiAudit.ran} ran · {p.aiAudit.skipped} skipped · ${p.aiAudit.costUsd.toFixed(2)} · {p.aiAudit.tokens} tokens</dd></div>
        </dl>
      </article>)}
    </div>}
    {history.data && <section aria-label="Audit history" className="rounded-lg border p-4">
      <h3 className="font-semibold">Audit history</h3>
      <p className="text-xs text-muted-foreground">Retention: {Object.entries(history.data.retentionDays).map(([id, d]) => `${id} ${d} days`).join(', ') || 'default 30 days'}.</p>
      {history.data.entries.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No operator actions or policy changes within retention.</p> : <ul className="mt-2 divide-y text-sm">
        {history.data.entries.map((e) => <li key={e.id} className="py-1.5" data-testid={`history-${e.id}`} data-kind={e.kind}>
          <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">{e.kind === 'policy-change' ? 'Policy change' : e.kind === 'waiver' ? 'Waiver request' : 'Operator action'}</span>
          <span className="font-medium">{e.projectId}</span> · {e.summary} <span className="text-xs text-muted-foreground">· {e.actor} · {stamp(e.at)}</span>
          {e.afterHash && <span className="ml-2 font-mono text-xs text-muted-foreground">{(e.beforeHash ?? 'none').slice(7, 15)} → {e.afterHash.slice(7, 15)}</span>}
        </li>)}
      </ul>}
    </section>}
  </section>
}
