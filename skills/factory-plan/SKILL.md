# Factory plan skill

Plan the single GitHub issue selected by the Cezar workflow. Use this skill when a selected issue needs a concrete, reviewable implementation plan or deliberate decomposition.

## Inputs and prerequisites

- Treat the workflow task as the authoritative issue and scope. Do not search for or select other issues, extract an issue number for a Factory command, or create issues yourself.
- Read `.factory/context/memory-recall.json` when present. It is the bounded result of the workflow's recall step; use only its returned memories and report a genuine miss or unavailable result honestly. Do not query memory tools again.
- Inspect relevant repository context, existing conventions, and tests needed to make the plan actionable. Do not implement production changes.
- Use the issue's linked specifications and project context when available. State assumptions where the supplied evidence does not resolve a requirement.

## Planning judgment

- Define the objective, testable acceptance criteria, explicit non-goals, dependencies, risks and mitigations, and ordered implementation steps.
- Choose `complexity:small` for isolated reversible work, `complexity:medium` for substantial multi-step or multi-file work, and `complexity:large` for cross-cutting architecture, broad migrations, or work that needs decomposition. Complexity informs downstream automation selection; do not inflate it to request a different worker.
- Mark the plan `ready` only when there are no unresolved blocking questions, risks are stated, and the work breakdown is verifiable. Use `not-ready` and name blocking questions when a human decision or missing prerequisite prevents a sound plan.
- Decompose only when the work is too large for one reviewable PR or the request explicitly asks to decompose. For each sub-issue, provide a self-contained objective, concrete tasks, acceptance criteria, and source section; use valid taxonomy and only zero-based dependencies on earlier sub-issues. Keep each issue to roughly one reviewable PR and obey the workflow cap.
- For decomposition, describe what decomposition completion means in `acceptanceCriteria`, summarize the grouping in `suggestedWorkBreakdown`, and note already completed scope in `nonGoals`.
- Keep risk aligned with repository policy. High-risk work remains subject to a separate human approval gate after planning.

## Output contract

Return one JSON object with `objective`, `acceptanceCriteria`, `nonGoals`, `risks`, `dependencies`, `suggestedWorkBreakdown`, `requiredProjectSkills`, `unresolvedQuestions`, `complexity`, and `readyNotReadyStatus`. Include `memoryRecall` when the workflow supplied its artifact, with the banks queried, memory IDs, count (maximum 8), and context characters (maximum 12,000). Include `subIssues` only for a `decomposed` plan; each item has `title`, `body`, `type`, `risk`, `complexity`, and optional `dependsOn`.

The workflow validator binds the selected issue identity and validates the final artifact against `schemas/plan.schema.json`. Do not supply or infer the `issue` field. The workflow owns validation, posting, sub-issue creation, and lifecycle routing.

Example model output:

```json
{
  "objective": "Add a bounded timeout to the configured verifier.",
  "acceptanceCriteria": "Given a verifier exceeds its configured timeout, when validation runs, then it returns an unavailable result with a timeout reason and does not report a pass.",
  "nonGoals": "Changing project test commands or the merge policy.",
  "risks": "A timeout that is too short could stop a legitimate long test; use the configured project limit and preserve elapsed-time evidence.",
  "dependencies": "Use the existing project validation configuration.",
  "suggestedWorkBreakdown": "1. Add timeout enforcement. 2. Record a structured timeout result. 3. Cover the behavior with a fixture.",
  "requiredProjectSkills": [],
  "unresolvedQuestions": "",
  "complexity": "complexity:small",
  "readyNotReadyStatus": "ready"
}
```

## Boundaries

Do not run commands or Factory scripts, write result files, post comments, create issues, change labels, or edit source. Return only the structured plan object. When evidence is insufficient, record the limitation in `unresolvedQuestions` instead of inventing detail.
