import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CheckCircle2Icon, ExternalLinkIcon, RefreshCwIcon, ScaleIcon, TriangleAlertIcon } from 'lucide-react'
import type { AnswerDecisionBody, DecisionItem, DecisionRequest, DecisionsResponse } from '@open-mercato/cezar-contract'

import { answerDecision, getDecisions, getDependencyGraph, getDependencyStalls, transitionDependencyDecision, type DependencyGraphData, type StallItem } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { isHttpUrl } from '@/lib/utils'
import { Markdown } from './task-thread/markdown'

/**
 * `/decisions` — the human attention queue for this project.
 *
 * Decision cards are GitHub issues in `factory:needs-help` / `factory:human-review` with the
 * question, its details and the suggested paths the agent posted (the `factory-decision:v1`
 * format, see `schemas/decision.schema.json`). Answering comments on the issue and returns it to
 * `factory:needs-plan`, so planning resumes through the normal workflow without a trip to GitHub.
 *
 * Older free-text escalations show current planning findings and issue context, and require a
 * written decision because they do not carry trustworthy structured option IDs.
 */

type Choice = { optionId?: string; note: string }

/** Whether every question on the card has a chosen path or a written answer. */
export function isAnswerable(decisions: readonly DecisionRequest[], choices: Record<string, Choice | undefined>): boolean {
  return decisions.every((d) => {
    const choice = choices[d.id]
    if (d.options.length === 0) return choice !== undefined && choice.note.trim().length > 0
    return choice !== undefined && (choice.optionId !== undefined || choice.note.trim().length > 0)
  })
}

export function buildAnswerBody(decisions: readonly DecisionRequest[], choices: Record<string, Choice | undefined>, extra: string): AnswerDecisionBody {
  return {
    answers: decisions.map((d) => {
      const choice = choices[d.id] ?? { note: '' }
      const note = choice.note.trim()
      return { decisionId: d.id, ...(choice.optionId !== undefined ? { optionId: choice.optionId } : {}), ...(note ? { note } : {}) }
    }),
    ...(extra.trim() ? { note: extra.trim() } : {}),
  }
}

export function DecisionsRoute() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.decisions,
    queryFn: ({ signal }) => getDecisions({ signal }),
    // The Factory moves issues on its own schedule; a stale list would offer answers to decisions
    // somebody already made, so revisit refetches (the server also re-checks before it writes).
    staleTime: 15_000,
  })
  const graphQuery = useQuery({
    queryKey: ['human-attention', 'dependency-graph'],
    queryFn: () => getDependencyGraph({ limit: 500 }),
    staleTime: 15_000,
  })
  const stallsQuery = useQuery({
    queryKey: ['human-attention', 'dependency-stalls'],
    queryFn: ({ signal }) => getDependencyStalls({ signal }),
    staleTime: 15_000,
  })
  const data = query.data
  const items = data?.items
  const decisionItems = items?.filter((item) => item.state === 'factory:needs-help') ?? []
  const signOffItems = items?.filter((item) => item.state === 'factory:human-review') ?? []
  const graph = graphQuery.data
  const stalls = stallsQuery.data?.items ?? []
  const blockedIssues = stalls.filter((item) => item.labels?.includes('factory:blocked'))
  // Dependency work that is progressing is a wait, not a request for the operator. Surface
  // verified human/external waits and stale blocked states that need recovery or triage.
  const attentionIssues = blockedIssues.filter((stall) => stall.class !== 'blocked')
  const approvals = graph?.decisions.filter((decision) => decision.requiredAuthorization === 'human-approval' && ['proposed', 'reopened'].includes(decision.state)) ?? []
  const anyAttention = decisionItems.length > 0 || signOffItems.length > 0 || attentionIssues.length > 0 || approvals.length > 0

  return (
    <div data-route="decisions" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Human attention</h1>
        <p className="text-[13px] text-soft-foreground">Decisions, approvals, and operator help the Factory is waiting on.</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          data-action="decisions-refresh"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCwIcon aria-hidden="true" className={query.isFetching ? 'size-3 animate-spin' : 'size-3'} />
          Refresh
        </Button>
      </header>

      <div className="flex flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {query.isError ? (
          <CenteredState icon={<TriangleAlertIcon />} tone="danger" title="Could not load decisions" subtitle={query.error.message} heading="h2" />
        ) : data === undefined || items === undefined ? null : !anyAttention && data.available && !graphQuery.isPending && !stallsQuery.isPending && !graphQuery.isError && !stallsQuery.isError ? (
          <CenteredState
            icon={<CheckCircle2Icon />}
            tone="neutral"
            title="Nothing needs your attention"
            subtitle="The Factory will list decisions, sign-offs, and blocked work that needs an operator here. Work waiting on an active dependency stays out of this queue."
            heading="h2"
          />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
            {!data.available ? <QueueError message={`GitHub decision issues are unavailable. ${data.reason ?? 'Sign in with the gh CLI and add a GitHub remote.'}`} /> : null}
            <section aria-labelledby="decision-queue-heading" className="space-y-3">
              <div><h2 id="decision-queue-heading" className="text-sm font-semibold">Decisions</h2><p className="text-xs text-muted-foreground">Architectural choices where the Factory needs your direction.</p></div>
              {!data.available ? <EmptyQueue>Decision issue details are unavailable while GitHub is unreachable.</EmptyQueue> : decisionItems.length ? <ul data-slot="decision-list" className="flex flex-col gap-4">{decisionItems.map((item) => <DecisionCard key={item.number} item={item} />)}</ul> : <EmptyQueue>Nothing is waiting for a decision.</EmptyQueue>}
            </section>

            <section aria-labelledby="signoff-queue-heading" className="space-y-3">
              <div><h2 id="signoff-queue-heading" className="text-sm font-semibold">Sign-offs</h2><p className="text-xs text-muted-foreground">Human review holds and explicit approvals. Approval changes are revision-checked and recorded.</p></div>
              {graphQuery.isError ? <QueueError message={graphQuery.error.message} /> : null}
              {signOffItems.length ? <ul className="flex flex-col gap-4">{signOffItems.map((item) => <DecisionCard key={item.number} item={item} />)}</ul> : null}
              {approvals.length ? <ul className="flex flex-col gap-3">{approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} graphRevision={graph!.revision} onComplete={() => queryClient.invalidateQueries({ queryKey: ['human-attention', 'dependency-graph'] })} />)}</ul> : null}
              {!graphQuery.isPending && !graphQuery.isError && !signOffItems.length && !approvals.length ? <EmptyQueue>No sign-off is pending.</EmptyQueue> : null}
            </section>

            <section aria-labelledby="operator-help-heading" className="space-y-3">
              <div><h2 id="operator-help-heading" className="text-sm font-semibold">Operator help</h2><p className="text-xs text-muted-foreground">Blocked issues waiting on outside input or requiring Factory recovery. Issues blocked by work that is progressing are omitted.</p></div>
              {(graphQuery.isError || stallsQuery.isError) ? <QueueError message={graphQuery.error?.message ?? stallsQuery.error?.message ?? 'Operator status is unavailable.'} /> : null}
              {attentionIssues.length ? <ul className="flex flex-col gap-3">{attentionIssues.map((stall) => <OperatorHelpCard key={stall.nodeId} stall={stall} />)}</ul> : null}
              {!graphQuery.isPending && !stallsQuery.isPending && !graphQuery.isError && !stallsQuery.isError && !attentionIssues.length ? <EmptyQueue>No blocked issues need operator help.</EmptyQueue> : null}
              {graph?.source.status && graph.source.status !== 'fresh' ? <p role="status" className="text-xs text-amber-700 dark:text-amber-300">Dependency data is {graph.source.status}; operator classifications may be incomplete{graph.source.warning ? `: ${graph.source.warning}` : '.'}</p> : null}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyQueue({ children }: { children: string }) {
  return <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{children}</p>
}

function QueueError({ message }: { message: string }) {
  return <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">Could not load this queue: {message}</p>
}

function OperatorHelpCard({ stall }: { stall: StallItem }) {
  const href = stall.url && isHttpUrl(stall.url) ? stall.url : undefined
  const kind = stall?.class === 'waiting' ? 'Waiting on a person or outside input' : stall?.class === 'stuck' ? 'Factory recovery needed' : 'Status unknown'
  return <li className="rounded-lg border border-amber-500/30 bg-card p-4" data-slot="operator-help-card" data-issue={stall.number}>
    <div className="flex flex-wrap items-start gap-2">
      <h3 className="min-w-0 flex-1 text-sm font-medium"><span className="font-mono text-muted-foreground">#{stall.number}</span> {stall.title}</h3>
      <Badge variant="outline">{kind}</Badge>
      {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-2">Issue <ExternalLinkIcon aria-hidden="true" className="size-3" /></a> : null}
    </div>
    <p className="mt-2 text-sm">{stall.detail}</p>
    {stall.blockerIds.length ? <p className="mt-1 text-xs text-muted-foreground">Blockers: {stall.blockerIds.join(', ')}</p> : null}
    {stall.bodyText ? <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">Issue details</summary><div className="mt-2 max-h-56 overflow-auto rounded bg-muted/30 p-3"><Markdown>{stall.bodyText}</Markdown></div></details> : null}
    {stall.class === 'stuck' ? <p className="mt-2 text-xs text-muted-foreground">This is a recovery signal, not a request to approve the blocked work. The Factory should restore a consuming workflow or correct the stale block.</p> : null}
  </li>
}

function ApprovalCard({ approval, graphRevision, onComplete }: {
  approval: DependencyGraphData['decisions'][number]
  graphRevision: number
  onComplete: () => void
}) {
  const [resolution, setResolution] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [pending, setPending] = useState(false)
  async function transition(to: 'approved' | 'deferred' | 'rejected') {
    if (resolution.trim().length < 8 || pending) return
    setPending(true); setError(''); setDone('')
    try {
      await transitionDependencyDecision({ expectedGraphRevision: graphRevision, decisionId: approval.id, to, resolution: resolution.trim() })
      setDone(to === 'approved' ? 'Approval recorded.' : to === 'deferred' ? 'Sign-off deferred.' : 'Proposal rejected.')
      onComplete()
    } catch (value) { setError(value instanceof Error ? value.message : 'The sign-off could not be recorded.') }
    finally { setPending(false) }
  }
  return <li className="rounded-lg border border-sky-500/30 bg-card p-4" data-slot="approval-card">
    <div className="flex flex-wrap items-start gap-2"><h3 className="min-w-0 flex-1 text-sm font-semibold">{approval.question}</h3><Badge variant="outline">Human approval</Badge></div>
    {approval.rationale ? <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{approval.rationale}</p> : null}
    <ul className="mt-2 list-disc pl-5 text-sm">{approval.options.map((option) => <li key={option}>{option}</li>)}</ul>
    {approval.evidence.length ? <ul className="mt-2 space-y-1 text-xs">{approval.evidence.map((item) => <li key={item.url}><a href={item.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{item.label}<ExternalLinkIcon aria-hidden="true" className="ml-1 inline size-3" /></a></li>)}</ul> : null}
    <label className="mt-3 block text-xs text-muted-foreground" htmlFor={`approval-reason-${approval.id}`}>Record your reason (required)</label>
    <Textarea id={`approval-reason-${approval.id}`} value={resolution} disabled={pending} onChange={(event) => setResolution(event.target.value)} maxLength={8_000} className="mt-1 min-h-16 text-[13px]" />
    <div className="mt-2 flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="outline" disabled={pending || resolution.trim().length < 8} onClick={() => void transition('deferred')}>Defer</Button>
      <Button size="sm" variant="danger-ghost" disabled={pending || resolution.trim().length < 8} onClick={() => void transition('rejected')}>Reject</Button>
      <Button size="sm" disabled={pending || resolution.trim().length < 8} onClick={() => void transition('approved')}>Approve</Button>
    </div>
    {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    {done ? <p role="status" className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{done}</p> : null}
    <p className="mt-2 text-[11px] text-muted-foreground">This action requires the local operator surface and records the graph revision used for the decision.</p>
  </li>
}

function DecisionCard({ item }: { item: DecisionItem }) {
  const queryClient = useQueryClient()
  const [choices, setChoices] = useState<Record<string, Choice | undefined>>({})
  const [extra, setExtra] = useState('')

  const setChoice = (id: string, patch: Partial<Choice>) =>
    setChoices((current) => ({ ...current, [id]: { note: '', ...current[id], ...patch } }))

  const submit = useMutation({
    mutationFn: () => answerDecision(item.number, buildAnswerBody(item.decisions, choices, extra)),
    onSuccess: () => {
      // Drop the card now; the server already moved the issue, the invalidation reconciles.
      queryClient.setQueryData<DecisionsResponse>(queryKeys.decisions, (existing) =>
        existing ? { ...existing, items: existing.items.filter((i) => i.number !== item.number) } : existing,
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.decisions })
      toast(`Answer recorded on #${item.number}. Planning resumes automatically.`)
    },
    onError: (error) => {
      toast(error.message, { tone: 'danger' })
      // A 409 means someone already moved it — refresh rather than leave a card that can never succeed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.decisions })
    },
  })

  const ready = isAnswerable(item.decisions, choices)
  const age = shortAge(item.askedAt ?? item.updatedAt)

  return (
    <li data-slot="decision-card" data-issue={item.number} className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <h2 className="min-w-0 flex-1 text-sm font-semibold leading-snug">
          <span className="font-mono text-soft-foreground">#{item.number}</span> {item.title}
        </h2>
        <Badge variant="outline" data-slot="decision-state">
          {item.state === 'factory:human-review' ? 'human review' : 'needs help'}
        </Badge>
        {age ? <span className="text-xs text-soft-foreground">asked {age} ago</span> : null}
        {isHttpUrl(item.url) ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
          >
            Issue <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        ) : null}
      </div>

      {item.background && item.background.length > 0 ? (
        <section data-slot="decision-background" aria-label={`What the Factory found on #${item.number}`} className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
          <h3 className="text-xs font-medium text-muted-foreground">What the Factory found</h3>
          {item.background.map((block) => (
            <div key={block.label} data-slot="decision-background-block" className="flex flex-col gap-0.5 text-[13px]">
              <span className="text-xs font-medium text-foreground">{block.label}</span>
              <DecisionMarkdown>{block.text}</DecisionMarkdown>
            </div>
          ))}
        </section>
      ) : null}

      {item.decisions.map((decision) => (
        <DecisionQuestion
          key={decision.id}
          decision={decision}
          choice={choices[decision.id]}
          disabled={submit.isPending}
          onChoose={(optionId) => setChoice(decision.id, { optionId })}
          onNote={(note) => setChoice(decision.id, { note })}
        />
      ))}

      {item.details ? (
        <details data-slot="decision-details" className="text-[13px]">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            {item.source === 'structured' ? 'Full Factory comment' : 'Factory escalation (free text)'}
          </summary>
          <div className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/40 p-3 text-xs">
            <DecisionMarkdown>{item.details}</DecisionMarkdown>
          </div>
        </details>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <Textarea
          data-slot="decision-extra"
          aria-label={`Additional instructions for #${item.number}`}
          value={extra}
          disabled={submit.isPending}
          onChange={(event) => setExtra(event.target.value)}
          placeholder="Additional instructions for the planner (optional)"
          maxLength={10_000}
          className="min-h-14 text-[13px]"
        />
        <div className="flex items-center justify-end gap-3">
          {!ready ? <span className="text-xs text-soft-foreground">Choose a path or write an answer for every question.</span> : null}
          <Button
            type="button"
            variant="contrast"
            size="sm"
            data-action="decision-submit"
            disabled={!ready || submit.isPending}
            onClick={() => submit.mutate()}
          >
            <ScaleIcon aria-hidden="true" className="size-3" />
            Send answer and resume
          </Button>
        </div>
      </div>
    </li>
  )
}

function DecisionQuestion({
  decision,
  choice,
  disabled,
  onChoose,
  onNote,
}: {
  decision: DecisionRequest
  choice: Choice | undefined
  disabled: boolean
  onChoose: (optionId: string | undefined) => void
  onNote: (note: string) => void
}) {
  const hasOptions = decision.options.length > 0
  return (
    <fieldset data-slot="decision-question" data-decision={decision.id} className="flex flex-col gap-2.5" disabled={disabled}>
      <legend className="text-sm font-medium leading-snug text-foreground">{decision.question}</legend>
      {decision.context ? (
        <section data-slot="decision-context" aria-label={`Context for: ${decision.question}`} className="flex flex-col gap-1 text-[13px] text-muted-foreground">
          <h3 className="text-xs font-medium text-foreground">Why this needs a decision</h3>
          <div className="max-h-80 overflow-y-auto rounded-md bg-muted/30 p-3">
            <DecisionMarkdown>{decision.context}</DecisionMarkdown>
          </div>
        </section>
      ) : null}

      {hasOptions ? (
        <div className="flex flex-col gap-2">
          {decision.options.map((option) => {
            const selected = choice?.optionId === option.id
            const recommended = option.id === decision.recommendedOptionId
            return (
              <label
                key={option.id}
                data-slot="decision-option"
                data-option={option.id}
                data-selected={selected}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 text-[13px] has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="radio"
                  name={`decision-${decision.id}`}
                  value={option.id}
                  checked={selected}
                  onChange={() => onChoose(option.id)}
                  className="mt-0.5"
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                    {option.label}
                    {recommended ? <Badge variant="secondary">Recommended</Badge> : null}
                  </span>
                  {option.summary ? <span className="whitespace-pre-wrap text-muted-foreground">{option.summary}</span> : null}
                  {option.tradeoffs ? (
                    <span className="text-xs text-soft-foreground">
                      <span className="font-medium">Trade-offs:</span> {option.tradeoffs}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </div>
      ) : (
        <p data-slot="decision-written-answer-guidance" className="rounded-md bg-muted/30 p-3 text-[13px] text-muted-foreground">
          This older decision has no reliable answer choices. Review the Factory findings above, then state the specific path you choose, why, and any constraints or trade-offs.
        </p>
      )}

      <Textarea
        data-slot="decision-note"
        aria-label={hasOptions ? `Your own answer for: ${decision.question}` : `Your decision (required): ${decision.question}`}
        value={choice?.note ?? ''}
        onChange={(event) => onNote(event.target.value)}
        placeholder={hasOptions ? 'Add detail, or answer in your own words instead (optional)' : 'Name the path you choose, why, and any constraints or trade-offs…'}
        maxLength={10_000}
        className="min-h-14 text-[13px]"
      />
    </fieldset>
  )
}

/** Render untrusted GitHub/agent-authored context as Markdown using the thread's safe link rules. */
function DecisionMarkdown({ children }: { children: string }) {
  return <Markdown>{children}</Markdown>
}
