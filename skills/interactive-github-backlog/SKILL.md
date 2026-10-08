---
name: interactive-github-backlog
description: Manage a project's GitHub backlog interactively from a local coding agent, including safe issue intake, lifecycle-aware updates, and decomposition of a Markdown plan into linked issues.
---

# Interactive GitHub backlog

Use this skill when the user asks to capture work in GitHub Issues, update an
issue's backlog status, or turn a Markdown script/spec/plan into a set of
reviewable issues. This is the local, human-directed companion to the Factory
automations; it is not an implementation or dispatch skill.

## Operating boundary

- Work only in the current repository. Resolve it with `gh repo view` and do
  not scan drives or guess another repository.
- Read the repository's `AGENTS.md`, contribution instructions, and any local
  `.ai/factory` guidance before mutating GitHub.
- Use the authenticated `gh` CLI for GitHub operations. Prefer structured
  output (`--json`) for reads, and re-read an issue immediately before editing
  it so a human or automation race is visible.
- Preserve existing issue bodies and labels unless the user asked for a
  change. Add a focused comment for decisions or context instead of rewriting
  history.
- Search for an existing issue before creating one. A matching title, source
  marker, or linked issue is evidence to update or report the existing issue,
  not to create a duplicate.
- Do not implement code, create branches or PRs, dispatch Cezar, claim a
  lease, or merge work as part of backlog management.

## Factory lifecycle rules

Factory lifecycle labels are mutually exclusive. The automation owns active
execution states, so do not manually replace these labels:

`factory:working`, `factory:review`, `factory:changes-requested`,
`factory:done`, or `factory:investigate`.

For a newly created executable issue, apply exactly one initial state,
`factory:new`, plus exactly one `type:*` and one `risk:*` label. Valid types
are `bug`, `feature`, `refactor`, `test`, `docs`, and `maintenance`; valid
risks are `low`, `medium`, and `high`. Add a `complexity:*` label only when
the size is known and the project convention requires it.

When the user explicitly asks to queue an issue for Factory planning, use the
project's installed lifecycle helper if present:

```powershell
pwsh -NoProfile -File .ai/factory/scripts/update-github-lifecycle.ps1 `
  -Issue <number> -State factory:needs-plan `
  -Type <type:...> -Risk <risk:...>
```

Pass `-Complexity complexity:large` for a decomposition candidate. The helper
validates labels, removes conflicting lifecycle labels, and emits the event
last. If the helper is absent, use `gh issue edit` only for the same explicit
human-directed transition, removing the old lifecycle label and adding the
new one in separate operations; never leave conflicting `factory:*` labels.

Human-directed status changes are limited to these cases:

- `factory:new` -> `factory:needs-plan` when the issue is classified and ready
  for the planner.
- `factory:needs-help` -> `factory:needs-plan` after the user has answered the
  blocking question.
- `factory:blocked` -> `factory:ready` only after the user confirms the
  external blocker is cleared and supplies the required complexity label.

Do not use `factory:ready` to skip planning, and do not set
`factory:working`, `factory:review`, or `factory:done` to make progress look
complete. `factory:needs-help` and `factory:human-review` require an explicit
human decision. If the requested update conflicts with these rules, explain
the conflict and stop before editing labels.

## Ordinary issue intake

For a new bug or feature:

1. Extract a concise title, objective, acceptance criteria, non-goals,
   dependencies, risk, and source/context links from the user's request.
2. Search open and recently closed issues for duplicates or an existing issue
   that should be reopened or updated.
3. Create one issue with a self-contained body. Include testable acceptance
   criteria and a `Source` section when the request came from a file.
4. Apply `factory:new`, one `type:*`, and one `risk:*` label at creation. Do
   not add an issue to an unrequested project or milestone.
5. Re-read the created issue and report its number, URL, labels, and the next
   legal action. Queue it for `factory:needs-plan` only if the user asked for
   that or explicitly asked to start Factory planning now.

For an existing issue, inspect its title, body, labels, comments, linked PRs,
and current state before changing anything. Use a comment for newly supplied
requirements, answers, acceptance-criteria changes, or a decision log. Edit
the body only when the user asks for a durable rewrite, and preserve sections
that are not in scope.

## Markdown decomposition

When the user asks to decompose a Markdown script/spec/plan:

1. Read the complete file, including unchecked and checked items, headings,
   tables, links, notes, and appendices. Treat checked items as completed
   unless repository evidence shows otherwise; list skipped completed work in
   the parent record.
2. Identify the delivery outcome, boundaries, shared prerequisites, and
   independently testable slices. Group tiny checklist items that belong to
   one change. Split work that spans multiple layers or would make one PR
   difficult to review. Prefer a small number of meaningful issues, with no
   more than 40 children in one pass.
3. Build an ordered dependency graph. Each child must be implementable from
   its own body, with an objective, concrete tasks, acceptance criteria,
   non-goals, source section/path, risk, type, and complexity. Dependencies
   refer to earlier child indexes or issue numbers; never invent a dependency
   merely because two items are related.
4. Search for an existing decomposition using the source path and the marker
   below. If one exists, reconcile it and report missing or stale children
   instead of creating a second parent.
5. Create a non-executable tracking parent first with `factory:tracking` and a
   body containing the source path, source commit or content hash when
   available, decomposition assumptions, skipped completed sections, and the
   proposed child table. Add this idempotency marker exactly once:

   `<!-- interactive-github-backlog: source=<repo-relative-path> -->`

6. Create each child once, in dependency order, with `factory:needs-plan`,
   exactly one `type:*`, one `risk:*`, and one `complexity:*` label. Link the
   parent and source section in every child. Add `Depends on` links to earlier
   child issues and record the parent in the child body. Never create a child
   with `factory:working` or `factory:ready`.
7. Re-read every created issue and the parent. Add one parent comment listing
   child numbers, dependencies, skipped sections, and any unresolved
   questions. If a child is ambiguous, use `factory:needs-help` only when the
   user must decide something; otherwise keep it at `factory:needs-plan` and
   state the assumption in its body.

The parent is a tracking record, not work for the planner. Children are the
executable units. A decomposition does not authorize implementation, issue
claiming, or automatic dispatch.

## Suggested issue shapes

Use this compact structure for ordinary issues:

```markdown
## Objective
...

## Acceptance criteria
- Given ..., when ..., then ...

## Non-goals
- ...

## Dependencies / risks
- ...

## Source
- `path/to/plan.md`, section "..."
```

Use this additional structure for decomposition children:

```markdown
## Parent
- #<tracking-issue>

## Objective
...

## Tasks
- ...

## Acceptance criteria
- Given ..., when ..., then ...

## Non-goals
- ...

## Depends on
- #<earlier-issue>, or `None`

## Source
- `path/to/script.md`, section "..."
```

## Completion report

Report what was actually changed: repository, created or updated issue
numbers/URLs, labels and lifecycle transitions, parent-child links, skipped
completed sections, duplicate matches, unresolved questions, and the next
legal Factory action. If a GitHub command fails, preserve the local analysis,
do not retry a mutation blindly, and report the exact command and observed
error.
