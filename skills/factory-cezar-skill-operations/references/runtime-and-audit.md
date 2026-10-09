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

The workflow command step (never the model) runs this entrypoint:

```text
pwsh -NoProfile -File /projects/cezar-factory/scripts/audit-backlog-labels.ps1
```

Do not add an inline PowerShell resolver, search for alternate scripts, inspect
the script source, or call `gh issue list` after it runs. The script's JSON
output is the sole candidate source.

The output's `candidates` array is the work awaiting classification; `staged`
records the durable reservation already written to each issue. It is not merely
a label-bootstrap result.

`factory:auditing` is the temporary audit reservation. It excludes a candidate
from another audit run without incorrectly escalating it to a human.

- Use `factory:needs-help` only for a real human decision, conflicting
  requirement, or missing external input.
- Route decomposition-needed work to `factory:needs-plan` with a defensible
  `type:*`, `risk:*`, and `complexity:large`, so the large planning automation
  can decompose it autonomously.
- Route tracking parents to `factory:tracking` and external blocks to
  `factory:blocked`.

Re-read the selected candidates' labels immediately before any closing edit.
After closing every candidate, write `.factory/backlog-label-audit.json` in the
same worktree. If an agent run is cancelled after the script stages candidates,
finish or safely close only that emitted set; never launch another candidate
discovery pass to compensate.

## Manual runs and diagnostics

The schedule automation supports:

```text
POST /api/v1/p/<project-id>/automations/<automation-id>/run
```

It returns a run ID and does not enable the schedule. Poll:

```text
GET /api/v1/p/<project-id>/runs/<run-id>
GET /api/v1/p/<project-id>/runs/<run-id>/history
```

Use the history to distinguish a runtime failure from an agent-policy failure.
If an agent begins re-running the candidate script, searching the filesystem,
reading the script, or re-listing GitHub issues, cancel it through:

```text
POST /api/v1/p/<project-id>/runs/<run-id>/cancel
```

Record the run ID, observed runtime path, deployed artifact versions, emitted
candidates, and any manually reconciled labels in this reference when a new
failure mode changes future operational decisions.
