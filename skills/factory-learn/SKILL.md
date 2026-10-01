<!--
managed-by: cezar-factory
factory-version: 0.2.0
source: skills/factory-learn/SKILL.md
-->
# Factory Learn Skill

## Responsibilities

- Review successful work and failures.
- Identify durable reusable knowledge.
- Avoid storing task-specific/transient facts.
- Recommend or update:
  - Project skills.
  - Testing guidance.
  - Architecture documentation.
  - Agent instructions.

## Initially

- Run manually or in observation-only mode.
- Require review before automatically modifying shared factory skills.

## Detailed Guidance

### 1. Review Successful Work and Failures

- Examine completed tasks that went well and identify why they succeeded.
- Analyze failed tasks or investigations to extract lessons learned.
- Look for patterns across multiple tasks.

### 2. Identify Durable Reusable Knowledge

- Focus on knowledge that will be valuable for future tasks.
- Durable knowledge includes:
  - Common pitfalls and how to avoid them.
  - Effective testing strategies for specific scenarios.
  - Architectural patterns that work well for the project.
  - Conventions and best practices that are not obvious from code alone.
- Avoid storing:
  - Task-specific details or transient facts.
  - One-off solutions that won't apply elsewhere.
  - Information already documented in code comments.

### 3. Recommend or Update

- **Project skills**: Suggest updates to `.ai/skills/` to capture project-specific knowledge.
- **Testing guidance**: Recommend improvements to test coverage, test patterns, or validation scripts.
- **Architecture documentation**: Suggest updates to architecture docs or ADRs.
- **Agent instructions**: Recommend improvements to factory skills or project skills based on lessons learned.

### 4. Review Before Modifying Shared Skills

- Initially, the learn skill should only recommend changes, not apply them.
- Human review is required before any shared factory skill is modified.
- This ensures that factory-wide changes are deliberate and vetted.

## Output Format

```json
{
  "durableKnowledgeCandidates": [
    {
      "topic": "Testing pattern for async operations",
      "suggestion": "Add a project skill covering async test patterns",
      "evidence": "Three tasks failed due to missing async waits"
    }
  ],
  "recommendedUpdates": [
    {
      "target": "project skill",
      "path": ".ai/skills/project-testing/SKILL.md",
      "change": "Add section on async test patterns"
    }
  ]
}
```