<!--
managed-by: cezar-factory
factory-version: 0.1.0
source: skills/factory-plan/SKILL.md
-->
# Factory Plan Skill

## Responsibilities

- Read the issue.
- Inspect relevant repository context.
- Identify ambiguities.
- Identify likely dependencies.
- Define acceptance criteria.
- Define non-goals.
- Propose implementation steps.
- Identify risks.
- Decide whether decomposition is needed.
- Update the issue with the plan.
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

### 2. Inspect Repository Context

- Search the codebase for related files, modules, or patterns.
- Look at recent changes in the same area to understand conventions.
- Check for existing tests that cover the relevant code paths.
- Identify the entry points and architecture that the change would touch.

### 3. Identify Ambiguities

- List any unclear requirements or assumptions.
- Note where the issue description is incomplete or contradictory.
- Flag anything that requires human judgment or domain expertise.

### 4. Identify Likely Dependencies

- External libraries or packages that may need updating.
- Other modules or services that the change affects.
- Configuration or environment setup required.
- Database migrations or data model changes.

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

- If the issue is large or complex, consider decomposing into sub-issues.
- Each sub-issue should be independently planable and implementable.
- Define the integration order and dependencies between sub-issues.

### 10. Update the Issue with the Plan

- Post the plan as a comment on the issue.
- Use a structured format that includes all required fields from the plan schema.
- Reference the plan schema fields explicitly.

### 11. Route the Issue

- If the plan is complete and meets the Definition of Ready:
  - Remove `factory:needs-plan`.
  - Add `factory:ready`.
- If the plan has unresolved blocking questions:
  - Remove `factory:needs-plan`.
  - Add `factory:needs-help`.
  - Include a clear summary of what human input is needed.

## Output Format

Produce a structured plan result conforming to `plan.schema.json`:

```json
{
  "objective": "Clear statement of what this task achieves",
  "acceptanceCriteria": "Testable criteria for completion",
  "nonGoals": "Explicitly stated out-of-scope items",
  "risks": "Identified risks and mitigation strategies",
  "dependencies": "Required dependencies and setup steps",
  "suggestedWorkBreakdown": "Ordered list of implementation steps",
  "requiredProjectSkills": ["skill-ids needed for this task"],
  "unresolvedQuestions": "Questions requiring human input (empty if none)",
  "readyNotReadyStatus": "ready or not-ready"
}
```