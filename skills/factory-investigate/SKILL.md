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

Classify the observed failure, distinguish evidence from hypotheses, assess
confidence, and recommend the next action. Use one classification: `implementation`,
`test`, `flaky-test`, `environment`, `dependency`, `merge-conflict`, `requirements`,
`architecture`, or `unknown`. Use confidence `low`, `medium`, or `high`.

Recommend automatic retry only for a clear implementation failure with a specific
repair. Re-plan other actionable failures; mark environment, dependency, and merge
blockers as blocked; request user input only for a major architectural decision.
Low confidence must not authorize an implementation retry. The deterministic
workflow router applies the lifecycle transition.

## Detailed Guidance

### 1. Stop Blindly Modifying Code

- Do not make further code changes until the root cause is understood.
- Gather evidence from previous attempts before continuing.

### 2. Analyze Repeated Failures

- Review all previous implementation attempts and their outcomes.
- Identify patterns in the failures.
- Look for common factors across attempts.
- Record which project or Factory memory bank was queried and use only relevant
  prior fixes; keep the full memory bank out of the prompt.

### 3. Classify the Failure

Use the following classification framework:

- **Implementation**: The code has a bug or does not meet requirements.
- **Test**: The test itself is flawed or tests the wrong behavior.
- **Flaky test**: The test passes or fails unpredictably due to timing or state.
- **Environment**: The failure is caused by the local or CI environment.
- **Dependency**: A third-party library or tool is causing the failure.
- **Merge conflict**: The failure is caused by conflicting changes from other branches.
- **Requirements**: The requirements are unclear, contradictory, or impossible.
- **Architecture**: The current architecture cannot support the required change.
- **Unknown**: The cause cannot be determined with available information.

### 4. Recommend and route the next action

- Based on the classification, recommend one of:
  - Retry implementation (only for implementation failures with clear fixes).
  - Investigate further (for environment, dependency, or unknown causes).
  - Request a user decision only for a major architectural choice.
  - Return external environment or dependency blockers to `factory:blocked`.
  - Re-plan and continue automatically for other failures.
- Set `automaticRetryAppropriate` and `confidence` honestly. A clear retry
  returns to `factory:ready`; an unclear implementation path returns to
  `factory:needs-plan` for an automatic revised plan. Only a major architectural
  choice may route to `factory:needs-help`; environment, dependency, and merge
  blockers route to `factory:blocked`.
- The workflow's escalation summary uses `evidence`, `attemptsReviewed`,
  `rootCauseHypothesis`, and `recommendedAction`. Make each concise and specific.

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
