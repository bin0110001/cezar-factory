import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CheckCircle2Icon, ExternalLinkIcon, RefreshCwIcon, ScaleIcon, TriangleAlertIcon } from 'lucide-react'
import type { AnswerDecisionBody, DecisionItem, DecisionRequest, DecisionsResponse } from '@open-mercato/cezar-contract'

import { answerDecision, getDecisions } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { isHttpUrl } from '@/lib/utils'

/**
 * `/decisions` — everything the Factory has parked for a person in this project.
 *
 * Each card is one GitHub issue in `factory:needs-help` / `factory:human-review` with the
 * question, its details and the suggested paths the agent posted (the `factory-decision:v1`
 * format, see `schemas/decision.schema.json`). Answering comments on the issue and returns it to
 * `factory:needs-plan`, so planning resumes through the normal workflow without a trip to GitHub.
 *
 * Older free-text escalations have no suggested paths; they render as one open question that is
 * answered in the user's own words.
 */

type Choice = { optionId?: string; note: string }

/** Whether every question on the card has a chosen path or a written answer. */
export function isAnswerable(decisions: readonly DecisionRequest[], choices: Record<string, Choice | undefined>): boolean {
  return decisions.every((d) => {
    const choice = choices[d.id]
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
  const query = useQuery({
    queryKey: queryKeys.decisions,
    queryFn: ({ signal }) => getDecisions({ signal }),
    // The Factory moves issues on its own schedule; a stale list would offer answers to decisions
    // somebody already made, so revisit refetches (the server also re-checks before it writes).
    staleTime: 15_000,
  })
  const data = query.data
  const items = data?.items

  return (
    <div data-route="decisions" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Decisions</h1>
        <p className="text-[13px] text-soft-foreground">Issues the Factory paused because they need a call from you.</p>
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
        ) : data === undefined || items === undefined ? null : !data.available ? (
          <CenteredState
            icon={<TriangleAlertIcon />}
            tone="neutral"
            title="GitHub is not reachable"
            subtitle={`Decisions come from GitHub issues. ${data.reason ?? 'Sign in with the gh CLI and add a GitHub remote.'}`}
            heading="h2"
          />
        ) : items.length === 0 ? (
          <CenteredState
            icon={<CheckCircle2Icon />}
            tone="neutral"
            title="Nothing is waiting on you"
            subtitle="When the Factory needs a major architectural call, it shows up here with the options it suggests."
            heading="h2"
          />
        ) : (
          <ul data-slot="decision-list" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {items.map((item) => (
              <DecisionCard key={item.number} item={item} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
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
          <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">{item.details}</pre>
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
        <p data-slot="decision-context" className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {decision.context}
        </p>
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
                  {option.summary ? <span className="text-muted-foreground">{option.summary}</span> : null}
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
      ) : null}

      <Textarea
        data-slot="decision-note"
        aria-label={hasOptions ? `Your own answer for: ${decision.question}` : `Your answer: ${decision.question}`}
        value={choice?.note ?? ''}
        onChange={(event) => onNote(event.target.value)}
        placeholder={hasOptions ? 'Add detail, or answer in your own words instead (optional)' : 'Write your answer…'}
        maxLength={10_000}
        className="min-h-14 text-[13px]"
      />
    </fieldset>
  )
}
