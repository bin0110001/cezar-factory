<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-investigate/SKILL.md
-->
# Factory Investigate Skill

## Purpose and invocation

Diagnose repeated failures for the single issue selected by the Cezar workflow.
This skill runs only after the workflow's resolved-issue preflight says the issue
is open and its bounded recall step has completed or reported a miss.

## Bounded inputs and forbidden effects

- Use the selected issue in `{{task}}`, the compact issue/PR/check context supplied
  by the workflow, and `.factory/context/memory-recall.json` when present.
- Inspect only evidence relevant to the current failure. Prefer summaries and
  bounded artifact tails; do not paste or request complete logs or the full memory
  bank. Record a real recall miss when the artifact is unavailable.
- Do not discover or select other work. Do not change code, run Factory scripts,
  edit GitHub labels, post comments, create PRs, or release changes.
- Write only the structured result artifact at
  `.factory/investigate-result.json`; the workflow validates it and owns routing.

## Required judgment

Review prior attempts and outcomes, then inspect only evidence needed to
diagnose this failure. State which attempts and memory evidence were available;
distinguish observed facts from hypotheses and assess confidence. Use one
classification: `implementation`, `test`, `flaky-test`, `environment`,
`dependency`, `merge-conflict`, `requirements`, `architecture`, or `unknown`.
Use confidence `low`, `medium`, or `high`.

Recommend automatic retry only for a clear implementation failure with a
specific repair. Re-plan other actionable failures; recommend `factory:blocked`
for environment, dependency, or merge blockers; request user input only for a
major architectural decision. Low confidence never authorizes an
implementation retry. The workflow owns lifecycle routing and retries this
skill only when result validation reports malformed output.

## Output Format

Return one JSON object with the investigation fields shown below. The workflow
validator supplies `issue` from the selected task and writes the final artifact
that conforms to `schemas/investigation-result.schema.json`:

- `evidence`: observed facts and the relevant artifact or check.
- `attemptsReviewed`: attempts and evidence actually inspected; state what was
  unavailable instead of implying it was reviewed.
- `rootCauseHypothesis`: the current explanation, clearly marked as a hypothesis.
- `recommendedAction`: one actionable next step with its reason.
- `automaticRetryAppropriate`: `true` only for a repairable implementation failure.

```json
{
  "failureClassification": "environment",
  "evidence": "The configured test runner was unavailable.",
  "attemptsReviewed": "One implementation attempt and its test artifact.",
  "rootCauseHypothesis": "The project test dependency is missing.",
  "confidence": "medium",
  "recommendedAction": "Install the declared dependency, then rerun validation.",
  "automaticRetryAppropriate": false
}
```

Set `automaticRetryAppropriate` from the evidence, not from this example. The
workflow supplies the selected issue to the validator, which binds it into the
result artifact. The workflow retries this agent only when deterministic result
validation fails.
