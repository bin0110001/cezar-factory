# User guide: resolving `factory:needs-help` issues

`factory:needs-help` is reserved for a major architectural decision that
materially changes compatibility, ownership, or the system contract. Routine
ambiguity is resolved with a documented, reversible assumption. Risk level,
missing user scheduling, and waiting for user review are not reasons to pause.

## When a user decision is needed

Ask one focused question only when two or more materially different
architectural choices would lead to incompatible outcomes and the repository
and issue evidence do not support a safe default. Include the observed problem,
relevant evidence, options, and a recommended choice.

While waiting for that decision, continue other eligible issues. Record the
answer in an issue comment, update the plan, and return the issue to
`factory:needs-plan` so it resumes through the normal workflow.

## Answering in Cezarium

The **Decisions** screen (`/decisions` in a project) lists every open issue in
`factory:needs-help` or `factory:human-review`, oldest ask first. Each card shows the
question, the details the agent gathered, and the suggested paths with the
recommended one marked. Choose a path (or answer in your own words), add optional
instructions for the planner, and press **Send answer and resume**. Cezarium posts the
answer as an issue comment and returns the issue to `factory:needs-plan`, so it resumes
through the normal workflow. If the issue moved in the meantime the answer is refused and
nothing is written.

## Decision request format

Agents ask with the optional `decisions` array on an intake, plan or investigation result
(`schemas/decision.schema.json`, checked by `validate-result.ps1`):

| Field | Meaning |
| --- | --- |
| `id` | Stable lowercase slug, unique within the issue. |
| `question` | One focused question. |
| `context` | Observed problem and evidence (Markdown). |
| `options[]` | At least two paths: `id`, `label`, `summary`, `tradeoffs`. |
| `recommendedOptionId` | The path the agent recommends. |

`unresolvedQuestions` stays as the human-readable summary. The router posts a readable
"Factory decision needed" comment carrying a `<!-- factory-decision:v1 {...} -->` marker
(with `<` and `>` escaped so text cannot close the comment). The answer is recorded as a
`factory-decision-answer:v1` comment. Escalations without the marker (older issues, or
results with only `unresolvedQuestions`) still appear, as one open question answered in free text.

## What should not use `factory:needs-help`

- Routine product or implementation ambiguity that has a safe reversible
  assumption.
- A high risk label by itself; full validation and independent technical
  review remain required, but user plan approval does not.
- CI, independent review, or release work already in progress.
- An external dependency. Use `factory:blocked`, record the exact dependency,
  and continue other eligible work.
- A defect found in post-delivery user review. The user will open a follow-up
  issue for it.

See [the lifecycle rules](lifecycle.md) for state ownership and transitions.