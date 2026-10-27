---
name: factory-learn
description: Extract evidence-backed, reusable lessons from completed work and propose bounded memory or documentation updates.
---

# Factory learn skill

Use this skill when asked to review completed work for durable lessons that could improve future tasks.

## Inputs and bounds

- Review only the tasks, run records, results, and artifacts supplied or named by the user. If none are available, ask for evidence instead of inventing history.
- Analyze at most five task records and return at most eight durable candidates and eight documentation recommendations per response. Do not load full memory banks or unrestricted run logs.
- Recall up to eight relevant Hindsight memories (maximum 12,000 characters) when a bounded recall tool is available. Treat a miss or unavailable tool as a limitation, not proof that no prior lesson exists.
- Keep Hindsight as operational memory. Git remains authoritative for architecture, policies, skills, and normative project documentation.

## Required judgment

- Separate observed facts from hypotheses. A repeated lesson needs evidence across the supplied tasks; a single event may support a candidate only when the underlying cause is directly demonstrated.
- Keep candidates reusable and actionable. Exclude transient, task-specific, already-documented, or speculative facts.
- Recommend a Git documentation change only when the evidence shows a stable convention or repeated gap. Name the exact target path and proposed change.
- Escalate unresolved architectural or policy choices as recommendations for human review; do not choose a system-contract change on the user's behalf.

## Output contract

Return one JSON object conforming to `schemas/learn-result.schema.json`. Put durable operational lessons in `durableKnowledgeCandidates` using `schemas/memory-candidate.schema.json`; put proposed Git changes in `recommendedUpdates`. Use empty arrays when the evidence supports no candidates. Include concrete evidence references in every candidate and recommendation.

Example:

```json
{
  "durableKnowledgeCandidates": [
    {
      "topic": "Retrying a failed verifier",
      "lesson": "The project verifier uses exit code 18 for unavailable checks; do not treat it as a test regression or retry code changes.",
      "kind": "recurring-failure",
      "evidence": "Runs 104 and 109 both recorded reasonCode=missing_command with exitCode=18."
    }
  ],
  "recommendedUpdates": []
}
```

## Boundaries

Do not write to Hindsight, edit skills or source, or modify project documentation unless the user explicitly approves that specific change. Return proposals only; approved changes use the normal reviewed workflow. Do not run Factory scripts or create issues, comments, or labels.
