---
name: interactive-github-backlog
description: Manage the current repository's GitHub backlog interactively: capture issues, make requested lifecycle transitions, or decompose a Markdown plan into linked issues.
---

# Interactive GitHub backlog

## Contract

Use this skill only for a user-requested GitHub backlog operation. It is not an
implementation skill. Backlog completion belongs to `factory-work-backlog`; an
automation-selected issue remains owned by its workflow.

### Prerequisites and bounded inputs

- Work in the current repository only. Resolve its GitHub repository with
  `gh repo view`; never scan drives or guess another project.
- Read `AGENTS.md`, contribution instructions, and applicable `.ai/factory`
  guidance before a GitHub mutation.
- Use the user's request and the relevant issue or source document as scope.
  For decomposition, read the complete document, including headings, tables,
  links, appendices, and checked items; verify checked items against repository
  evidence before treating them as complete.
- Use authenticated `gh` output in structured form where available. Re-read
  issues immediately before editing and after each mutation.

### Required judgment

- Search open and recently closed issues for matching titles, source markers,
  and links. Update or report a match; never create a duplicate.
- Preserve issue history, unrelated body sections, labels, dependencies, and
  linked records. Prefer a focused comment unless a durable rewrite was asked
  for.
- Extract testable objective, acceptance criteria, non-goals, dependencies,
  risk, type, and source context. Resolve routine ambiguity with a stated
  reversible assumption; ask only about a decision that changes architecture,
  ownership, or the system contract.
- For decomposition, group small related items, split work across reviewable
  layers, create no more than 40 children per pass, and order dependencies so
  each child can be implemented from its own body.

### Effects and limits

- Create, edit, comment on, or transition issues only as requested by the user.
  Do not implement code, create branches or PRs, dispatch Cezar, claim leases,
  or merge work in this skill.
- Never manually set automation-owned active states:
  `factory:working`, `factory:review`, `factory:changes-requested`,
  `factory:done`, or `factory:investigate`.
- A new executable issue gets exactly one `factory:new`, one `type:*` from
  `bug|feature|refactor|test|docs|maintenance`, and one `risk:*` from
  `low|medium|high`. Add `complexity:*` only when known and required by project
  convention.
- Manual lifecycle changes are limited to `factory:new` →
  `factory:needs-plan`, `factory:needs-help` → `factory:needs-plan` after the
  architectural decision is recorded, and `factory:blocked` → an executable
  state after evidence confirms the blocker is cleared. Preserve type, risk,
  complexity, and unrelated labels. Never use `factory:ready` to skip planning.
- Factory scripts run only from workflow `command:` steps. Do not invoke them
  or ask the model to run them. When a workflow selected an issue, do not
  duplicate its script-owned selection or state-routing effects through `gh`.

## Ordinary issue intake and updates

For a new request, derive a concise title and self-contained body from the
request, search for duplicates, create one issue with `factory:new`, one type,
and one risk, then re-read it and report its identity, URL, labels, and next
legal action. Add a project or milestone only when explicitly requested. Queue
it for `factory:needs-plan` only when the user asks to queue it or start
planning.

For an existing issue, inspect its body, labels, comments, links, and state.
Before editing, re-read its current revision. Preserve content outside the
requested scope. Record new requirements or decisions in a focused comment
unless the user asked for a durable body rewrite. Afterward, re-read and report
the observed state.

## Markdown decomposition

1. Identify the outcome, shared prerequisites, boundaries, and completed work.
   Search for an existing decomposition using the source path and marker; if it
   exists, reconcile it rather than making another parent.
2. Prepare a tracking parent body with source path and commit/hash when
   available, assumptions, skipped completed sections, and the proposed child
   table. The parent is non-executable and receives `factory:tracking`.
3. Add exactly one marker to the parent:
   `<!-- interactive-github-backlog: source=<repo-relative-path> -->`
4. Create children once, in dependency order. Each body states objective, tasks,
   testable acceptance criteria, non-goals, risk, type, complexity, source,
   parent link, and dependencies on earlier children. Give each
   `factory:needs-plan`, exactly one type, one risk, and one complexity label.
   Never put children into `factory:working` or `factory:ready`.
5. Re-read the parent and every child. Add one parent comment listing child
   numbers and dependencies, completed sections skipped, and unresolved
   questions. Keep routine ambiguity at `factory:needs-plan` with the
   assumption recorded; use `factory:needs-help` only when a user decision is
   required.

## Report

Return a concise structured summary:

- `repository`: resolved owner/name
- `changed`: issue numbers and URLs, labels, transitions, and parent/child links
- `duplicates`: matching issues updated or reported
- `skipped`: completed sections omitted from decomposition
- `assumptions_or_questions`: recorded assumptions or unresolved major choice
- `next_action`: the next legal Factory action

Report only observed results. If a command fails, preserve local analysis, do
not blindly retry a mutation, and include the command and error. Never claim
backlog completion while a requested action or required gate remains open.
