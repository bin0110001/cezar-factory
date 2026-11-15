import { useQuery } from '@tanstack/react-query'
import type { VerificationEvidenceResponse } from '@open-mercato/cezar-api-client'
import { getVerificationEvidence, verificationEvidenceContentUrl } from '@/api/client'

type Group = VerificationEvidenceResponse['groups'][number]
type Item = Group['items'][number]

const outcomeTone: Record<string, string> = {
  passed: 'text-emerald-600', failed: 'text-destructive', incomplete: 'text-amber-600', inconclusive: 'text-amber-600',
}

function Frame({ verificationId, item, label }: { verificationId: string, item: Item | undefined, label: string }) {
  if (!item) return <div className="rounded border border-dashed p-3 text-xs text-muted-foreground" data-testid={`evidence-missing-${label}`}>{label}: not recorded</div>
  return (
    <figure className="rounded border p-2" data-testid={`evidence-${item.id}`}>
      <figcaption className="mb-1 text-xs font-medium">{label} · {item.role} · {new Date(item.capturedAt).toLocaleTimeString()}</figcaption>
      {item.preview === 'available'
        ? <img className="max-h-48 w-auto rounded border bg-muted object-contain" alt={`${label} capture for ${item.role}`} src={verificationEvidenceContentUrl(verificationId, item.id, 'preview')} loading="lazy" />
        : <p className="text-xs text-muted-foreground">{item.preview === 'denied' ? 'Preview withheld (redaction or access policy).' : 'No inline preview for this media type or size.'}</p>}
      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{item.kind} · {item.bytes.toLocaleString()} bytes · {item.renderer.displayBackend} · {item.redactionState}</p>
      {item.download === 'available' && <a className="text-xs text-primary underline underline-offset-2" href={verificationEvidenceContentUrl(verificationId, item.id, 'download')} download>Download</a>}
    </figure>
  )
}

/** Visual evidence for one run: expected/actual/diff per test, role captures, and a time-aligned session timeline. */
export function VerificationEvidenceGallery({ verificationId, commitSha }: { verificationId: string, commitSha: string }) {
  const evidence = useQuery({
    queryKey: ['verification-history', verificationId, 'evidence', commitSha],
    queryFn: ({ signal }) => getVerificationEvidence(verificationId, { commitSha }, { signal }),
    staleTime: 30_000,
  })
  if (evidence.isPending) return <p className="text-xs text-muted-foreground" role="status">Loading visual evidence…</p>
  if (evidence.isError) return <p className="text-xs text-destructive" role="alert">Visual evidence unavailable: {evidence.error.message}</p>
  const data = evidence.data
  if (data.state === 'none') return null
  return (
    <section id="verification-visual-evidence" data-testid="verification-visual-evidence">
      <h2 className="text-sm font-semibold">Visual evidence</h2>
      <p className="text-xs text-muted-foreground">
        Commit <span className="font-mono">{data.commitSha.slice(0, 12)}</span> · policy {data.policyVersions.join(', ') || 'none'} ·{' '}
        <span className={outcomeTone[data.outcome ?? ''] ?? ''}>{data.state === 'stale' ? 'stale revision, not a verdict' : data.outcome}</span>
      </p>
      <div className="mt-2 space-y-3">
        {data.groups.map((group) => {
          const side = (name: Item['side']) => group.items.find((item) => item.side === name)
          const others = group.items.filter((item) => item.side === 'other')
          return (
            <div key={group.testId} className="rounded-md border p-3" data-testid={`evidence-group-${group.testId}`}>
              <p className="text-sm font-medium">{group.testId} <span className={`text-xs ${outcomeTone[group.outcome]}`}>{group.outcome}</span></p>
              <p className="text-xs text-muted-foreground">{group.reason}{group.withheld > 0 ? ` · ${group.withheld} item(s) withheld by access policy` : ''}</p>
              {group.missingRoles.length > 0 && <p className="text-xs text-amber-600" role="alert">Missing roles: {group.missingRoles.join(', ')}</p>}
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Frame verificationId={verificationId} item={side('expected')} label="Expected" />
                <Frame verificationId={verificationId} item={side('actual') ?? others[0]} label="Actual" />
                <Frame verificationId={verificationId} item={side('diff')} label="Diff" />
              </div>
              {others.length > 1 && <div className="mt-2 grid gap-2 sm:grid-cols-3">{others.map((item) => <Frame key={item.id} verificationId={verificationId} item={item} label="Role capture" />)}</div>}
            </div>
          )
        })}
      </div>
      {data.timeline.length > 0 && <ol className="mt-3 space-y-1 text-xs" aria-label="Session timeline">
        {data.timeline.map((entry) => <li key={entry.itemId} className="grid grid-cols-[6rem_1fr] gap-2"><time>{new Date(entry.capturedAt).toLocaleTimeString()}</time><span>{entry.role} · {entry.kind} · session {entry.sessionId} · {entry.testId}</span></li>)}
      </ol>}
    </section>
  )
}
