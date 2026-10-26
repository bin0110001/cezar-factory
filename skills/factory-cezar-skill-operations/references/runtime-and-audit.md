# Cezar runtime and backlog-audit operations

## Runtime facts

- Active Cezar runs execute in isolated project worktrees under
  `/projects/<project>/.ai/cezar/worktrees/<run-id>`.
- Factory runtime scripts execute from
  `/projects/cezar-factory/scripts/`.
- Cezar loads workflow and skill material from the project's managed `.ai`
  layer. Updating the Factory source or its automation JSON alone does not
  guarantee that the next worktree has changed scripts, skills, or workflows.
- On Bazzite, inspect the running `cezar` container and its mounted files, not
  only the host checkout. A host checkout can be current while the active
  container runtime is stale.

## Backlog-label audit

The maintenance workflow's `command:` step runs the collector before invoking
the skill. The model reads only the worktree-local input artifact produced by
that step; it does not invoke the collector, search for alternate scripts,
inspect script source, or call `gh issue list`. The workflow artifact is the
sole candidate source.

The output's `candidates` array is the work awaiting classification; `staged`
records the durable reservation already written to each issue. It is not merely
a label-bootstrap result.

`factory:auditing` is the temporary audit reservation. It excludes a candidate
from another audit run without incorrectly escalating it to a human.

- Use `factory:needs-help` only for a major architectural decision that
  materially changes compatibility, ownership, or the system contract. Use
  `factory:blocked` for missing external input and document reversible
  assumptions for routine conflicts.
- Route decomposition-needed work to `factory:needs-plan` with a defensible
  `type:*`, `risk:*`, and `complexity:large`, so the large planning automation
  can decompose it autonomously.
- Route tracking parents to `factory:tracking` and external blocks to
  `factory:blocked`.

The skill writes its bounded proposal to `.factory/backlog-label-audit.json`.
The workflow's deterministic consumer rechecks current state and applies the
proposal. If a run is cancelled after candidates are reserved, the maintenance
recovery step reconciles those reservations; do not manually close issues or
launch another candidate discovery pass.

## Queueing and diagnostics

When the user asks to run an automation, queue it with
`cez automation run <id>`, report the returned task ID, and stop. Do not poll,
inspect its worktree or artifacts, or cancel it as a follow-up. Inspect run
history only when the user explicitly asks for run diagnostics; use the Cezar
run-history interface for that request.

Record observed runtime paths, deployed artifact versions, emitted candidates,
and any manually reconciled labels here when a new failure mode changes future
operational decisions.
