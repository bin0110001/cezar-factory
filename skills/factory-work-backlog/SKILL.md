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

## Local interactive fallback

When the user asks to continue this repository's backlog in a local interactive
dev window and Cezar scheduling or planning is unavailable, use GitHub as the
queue and communication record. This fallback is for an ordinary local dev
session only; it must never take over a verified Factory-managed run or a Cezar
runner session.

- Read the existing issue queue and select the next eligible issue by readiness,
  dependencies, explicitly recorded priority, and age. Respect active work and
  dependency blockers. Do not invent or infer human-owned priority values.
- Plan from the selected issue's acceptance criteria and applicable repository
  guidance. Record the short plan, assumptions, and progress in GitHub so the
  work remains visible while Cezar is unavailable.
- When taking an issue locally, set `factory:working`, add
  `factory:interactive`, and leave a concise progress comment. Continue in an
  isolated worktree when the repository workflow requires one; preserve all
  unrelated changes and stage only files for the issue.
- Use the normal validation, review, PR, and release gates. A failed Cezar
  automation does not authorize creating a replacement automation task. A
  direct local takeover is allowed when the user has requested local backlog
  work and the failed/active automation state has been checked in GitHub.
- Do not rely on a Cezar-generated plan artifact or result router in this path.
  Keep the issue stage and handoff visible in GitHub, then continue with other
  eligible issues when one is blocked on CI, review, or release.

The fallback does not change workflow ownership: Factory scripts still run only
from `command:` steps in `workflows/*.yaml`, and a verified workflow still owns
issue selection, script execution, labels, and routing.
