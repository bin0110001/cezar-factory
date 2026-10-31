<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-plan/SKILL.md
-->
# Factory Plan Skill

## Responsibilities

- Read the issue.
- Recall a bounded set of relevant Hindsight memories before planning when the
  Hindsight MCP integration is available.
- Inspect relevant repository context.
- Identify ambiguities.
- Identify likely dependencies.
- Define acceptance criteria.
- Define non-goals.
- Propose implementation steps.
- Identify risks.
- Estimate delivery complexity.
- Decide whether decomposition is needed.
- Write the structured plan result for the workflow to post to the issue.
- Route to:
  - `factory:ready`
  - `factory:needs-help`

## Must not

- Implement production changes.

## Detailed Guidance

### 1. Read the Issue

- Extract the issue title, body, and any linked PRs or commits.
- Note any existing comments, especially from humans.
- Identify the work type (`type:bug`, `type:feature`, etc.) and risk level (`risk:low`, `risk:medium`, `risk:high`).
- Set exactly one complexity label in the plan result: `complexity:small` for an isolated, reversible change; `complexity:medium` for substantial multi-step or multi-file work; `complexity:large` for cross-cutting architecture, broad migrations, or work requiring decomposition. This label selects the automation model after planning.
- Query the project bank first and the Factory bank when cross-project lessons
  are relevant. Limit recall to at most 8 memories and 12,000 characters.
- Record the bank(s) queried and memory identifiers in `memoryRecall`; never
  paste an entire memory bank into the planning context.

### 2. Inspect Repository Context

- Search the codebase for related files, modules, or patterns.
- Look at recent changes in the same area to understand conventions.
- Check for existing tests that cover the relevant code paths.
- Identify the entry points and architecture that the change would touch.

### 3. Identify Ambiguities

- Resolve routine ambiguity using the safest reversible assumption and record
  it in the plan. Do not return `not-ready` merely because the issue could be
  more detailed.
- Ask the user only when an unresolved major architectural decision would
  materially change compatibility, ownership, or the system contract. Other
  missing context should be handled with a documented assumption or bounded
  investigation.

### 4. Identify Likely Dependencies

- External libraries or packages that may need updating.
- Other modules or services that the change affects.
- Configuration or environment setup required.
- Database migrations or data model changes.
- Describe these dependencies in the plan. They are not permission to add a
  native GitHub blocker relationship or set `factory:blocked`. An explicit
  user request authorizes the GitHub relationship; only a verified external
  blocker justifies the `factory:blocked` label.

### 5. Define Acceptance Criteria

- Write concrete, testable criteria that clearly define "done".
- Use the format: "Given [context], when [action], then [expected outcome]".
- Ensure criteria are verifiable through code, tests, or manual inspection.
- Align criteria with the issue's intent and any linked specifications.

### 6. Define Non-Goals

- Explicitly state what is out of scope for this task.
- Prevent scope creep by clarifying boundaries.
- Note any adjacent work that should be tracked separately.

### 7. Propose Implementation Steps

- Break the work into logical, sequential steps.
- Each step should be small enough to validate independently.
- Include test creation as part of the implementation steps.
- Consider edge cases and error handling in the steps.

### 8. Identify Risks

- Assess the risk level (low, medium, high) based on:
  - Blast radius (number of files, public API changes).
  - Security or data sensitivity.
  - Performance impact.
  - Architectural complexity.
- Document specific risk factors and mitigation strategies.

### 9. Decide Whether Decomposition Is Needed

- Decompose when the issue is too large to implement and review as one PR, or when the issue itself asks you to break a document, spec or epic into issues.
  - Set `readyNotReadyStatus` to `decomposed` and list the sub-issues in `subIssues`. Do **not** create issues yourself; the workflow creates them from your list and queues them as `factory:needs-plan` for autonomous planning and implementation in dependency order. The parent closes as a tracking record; no human scheduling handoff is required.
- Each sub-issue is `{ "title", "body", "type", "risk", "complexity", "dependsOn" }`:
  - `title`: short and unique, in the form a maintainer would file ("Phase 3: deterministic evaluation engine").
  - `body`: self-contained. State the objective, the concrete tasks, acceptance criteria, and a pointer to the source (document path and section). A planner reading only this issue must be able to plan it without the parent.
  - `type`: one of `type:bug|feature|refactor|test|docs|maintenance`. `risk`: `risk:low|medium|high` per the project's risk guidance. `complexity`: one of `complexity:small|medium|large`.
  - `dependsOn`: zero-based indexes of earlier entries in `subIssues` that must land first. Never self-reference.
- `dependsOn` is sequencing metadata for the decomposition and parent summary.
  The workflow records it in the plan table; it does not create native GitHub
  blocker relationships. Never mark a child `factory:blocked` because it has
  a `dependsOn` entry. Use `factory:blocked` only when the issue itself has a
  verified external blocker and the required external input or event is
  identified.
- Size each sub-issue to roughly one reviewable PR; group tiny related tasks together, split anything spanning several layers. Prefer fewer, meaningful issues over one per checkbox; the cap is `max_sub_issues` in `policies/retry.yaml` (default 40).
- Order `subIssues` in a sensible delivery order. Skip work already completed (for example checked-off items in a plan document, or things the repository already implements; verify in the code, not just the checkboxes). Say what you skipped in `nonGoals`.
- In decomposition mode `acceptanceCriteria` describes what "decomposition done" means (for example "every unchecked item in section 31 is covered by exactly one sub-issue"), and `suggestedWorkBreakdown` summarises the grouping.

### 10. Record the Plan

- Write the structured result to `.factory/plan-result.json`. The workflow
  validates it, posts the plan comment, and updates the issue state.
- Include all required fields from the plan schema. Do not post a separate
  comment or edit lifecycle labels from this skill.

### 11. Route the Issue

- Set `readyNotReadyStatus` to `ready` when the plan meets the Definition of Ready. Use `not-ready` only when an unresolved major architectural decision materially changes compatibility, ownership, or the system contract; record that specific choice in `unresolvedQuestions`. Risk level alone never blocks implementation.
- Do **not** edit `factory:*` labels. Write the structured result to `.factory/plan-result.json` (create the directory), including the issue number in `issue`. The workflow validates it and routes the issue state.
- The workflow posts the plan and routes ready work to `factory:ready`. Risk level alone never holds a plan for user approval. Use `factory:needs-help` only for an unresolved major architectural decision. For `decomposed`, the workflow creates and queues sub-issues, posts their dependency order, and closes the parent as a tracking record.

## Output Format

Produce a structured plan result conforming to `plan.schema.json`:

```json
{
  "issue": 272,
  "objective": "Prevent an empty test suite from reporting success.",
  "acceptanceCriteria": "An empty suite reports a non-passing result.",
  "nonGoals": "Do not change the project's test cases.",
  "risks": "Existing projects may rely on the old empty-suite behavior.",
  "dependencies": "None.",
  "suggestedWorkBreakdown": "Add a regression test, correct the result, then validate.",
  "requiredProjectSkills": ["factory-implement"],
  "unresolvedQuestions": "",
  "complexity": "complexity:medium",
  "readyNotReadyStatus": "ready"
}
```

Use `not-ready` with the blocking questions in `unresolvedQuestions` when
the work cannot start. Use `decomposed` with schema-valid `subIssues` when the
workflow needs to create smaller issues. Omit `subIssues` for a ready plan.

## Already-resolved issues

The workflow's first step (`check-already-resolved.ps1`) finishes work on a closed or `factory:done` issue by
writing `.factory/already-resolved.json`. If that file exists, reply with one line saying the issue is already
resolved and stop: no discovery, no edits, no result file. Every later workflow step then no-ops.
