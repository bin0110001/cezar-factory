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