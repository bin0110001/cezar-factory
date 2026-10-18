<!--
managed-by: cezar-factory
source: skills/factory-work-backlog/SKILL.md
-->
# Factory Work Backlog Skill

Use this skill when the user asks to complete, advance, or work through the
repository's outstanding issues.

## Operating rules

- Do not wait for the user to schedule an individual issue. Select the next
  eligible issue from the existing backlog using readiness, dependency order,
  priority, and age.
- Follow the normal plan, implementation, validation, independent review, and
  release workflows. Do not bypass their script ownership or validation gates.
- Work issues serially when a separate issue worktree is required. While an
  issue waits for CI, independent technical review, or release, continue with
  the next eligible issue instead of ending the backlog task.
- Decomposition is executable queue creation. Children are planned and
  implemented automatically in dependency order; the parent is a tracking
  record and does not wait for user scheduling.
- User review is post-delivery feedback, not an approval gate. If the user later
  finds a defect, they will file a follow-up issue.
- Ask the user only for a major architectural decision that materially changes
  compatibility, ownership, or the system contract. Resolve routine ambiguity
  with the safest reversible assumption and document it.
- A missing handoff artifact or failed automation blocks that issue attempt,
  not the entire backlog task. Report the exact failure, continue other
  eligible issues, and do not create replacement tasks for an automation-owned
  issue.
- If no eligible issue remains, report concrete external blockers and any
  issues awaiting independent review or release. Do not ask the user to choose
  or schedule the next piece of work.

## Workflow ownership

Factory scripts run only from `command:` steps in `workflows/*.yaml`. This
skill never instructs the model to run those scripts, extract an issue number
for them, or repeat issue selection already performed by a workflow. The
workflow prepares the issue context and owns state labels and result routing.
