<!--
managed-by: cezar-factory
factory-version: 0.3.1
source: skills/factory-investigate/SKILL.md
-->
# Factory Investigate Skill

## Responsibilities

- Stop blindly modifying code.
- Analyze repeated failures.
- Classify failure as:
  - Implementation.
  - Test.
  - Flaky test.
  - Environment.
  - Dependency.
  - Merge conflict.
  - Requirements.
  - Architecture.
  - Unknown.
- Recommend next action.
- Route back to implementation only when justified.
- Otherwise escalate.

## Detailed Guidance

### 1. Stop Blindly Modifying Code

- Do not make further code changes until the root cause is understood.
- Gather evidence from previous attempts before continuing.

### 2. Analyze Repeated Failures

- Review all previous implementation attempts and their outcomes.
- Identify patterns in the failures.
- Look for common factors across attempts.

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

### 4. Recommend Next Action

- Based on the classification, recommend one of:
  - Retry implementation (only for implementation failures with clear fixes).
  - Investigate further (for environment, dependency, or unknown causes).
  - Escalate to human (for requirements, architecture, or unknown causes).

### 5. Route Appropriately

- Set `automaticRetryAppropriate` and `confidence` honestly: the workflow retries (`factory:ready`) only when it is true, confidence is not `low`, and no earlier investigation retry was made; otherwise it escalates with `factory:needs-help`.
- Do **not** edit `factory:*` labels. Write the structured result to `.factory/investigate-result.json` (create the directory), including the issue number in `issue`. The workflow validates it and routes the issue state.
- Use these exact `failureClassification` values: implementation, test, flaky-test, environment, dependency, merge-conflict, requirements, architecture, unknown.
- The escalation summary posted by the workflow is built from your result. Make these fields complete:
  - Fields feeding the summary:
    - Observed problem.
    - Attempts made.
    - Relevant logs/artifacts.
    - Current hypothesis.
    - Recommended human decision.

## Output Format

Produce an investigation result conforming to `investigation-result.schema.json`:

```json
{
  "failureClassification": "implementation | test | flaky-test | environment | dependency | merge-conflict | requirements | architecture | unknown",
  "evidence": "Summary of evidence collected",
  "attemptsReviewed": "Description of previous attempts and outcomes",
  "rootCauseHypothesis": "Best hypothesis for the root cause",
  "confidence": "high | medium | low",
  "recommendedAction": "Specific recommended next step",
  "automaticRetryAppropriate": true | false
}
```