import { describe, expect, it } from 'vitest';
import { checkFailureOutcome, shouldRetryCheck, workflowStepSchema } from './types.ts';

describe('typed check failure outcomes', () => {
  const check = { id: 'verify', onFail: { retry: 'implement', max: 2, retryOn: [1] } };

  it('classifies an exit code excluded by retryOn as infrastructure failure', () => {
    expect(checkFailureOutcome(check, 2, false)).toEqual({
      kind: 'infrastructure_failure', reasonCode: 'infrastructure_failed', stepId: 'verify',
    });
  });

  it('classifies an exhausted retryable exit as task failure', () => {
    expect(checkFailureOutcome(check, 1, true)).toEqual({
      kind: 'task_failure', reasonCode: 'task_failed', stepId: 'verify',
    });
  });

  it('leaves retryable work and checks without a retry policy unclassified', () => {
    expect(checkFailureOutcome(check, 1, false)).toBeUndefined();
    expect(checkFailureOutcome({ id: 'lint' }, 1, true)).toBeUndefined();
  });

  it('never loops a mapped infrastructure category into a coding agent', () => {
    const categorized = { id: 'e2e', onFail: { retry: 'implement', max: 2, retryOn: [2] }, failureReasons: { '2': 'provider_quota' as const } };
    expect(shouldRetryCheck(categorized, 2)).toBe(false);
    expect(checkFailureOutcome(categorized, 2, false)).toEqual({
      kind: 'infrastructure_failure', reasonCode: 'provider_quota', stepId: 'e2e',
    });
  });

  it('retries only explicitly mapped work verdicts when taxonomy is configured', () => {
    const regression = { id: 'tests', onFail: { retry: 'implement', max: 1, retryOn: [1] }, failureReasons: { '1': 'test_regression' as const } };
    const unknown = { ...regression, failureReasons: {} };
    expect(shouldRetryCheck(regression, 1)).toBe(true);
    expect(checkFailureOutcome(regression, 1, true)).toEqual({
      kind: 'task_failure', reasonCode: 'test_regression', stepId: 'tests',
    });
    expect(shouldRetryCheck(unknown, 1)).toBe(false);
    expect(checkFailureOutcome(unknown, 1, false)).toEqual({
      kind: 'infrastructure_failure', reasonCode: 'unknown', stepId: 'tests',
    });
  });

  it('retries a malformed agent result within budget and classifies exhaustion as a contract failure', () => {
    const malformed = {
      id: 'validate-plan',
      onFail: { retry: 'plan', max: 1, retryOn: [1] },
      failureReasons: { '1': 'malformed_result' as const, '10': 'configuration' as const },
    };
    expect(shouldRetryCheck(malformed, 1)).toBe(true);
    expect(shouldRetryCheck(malformed, 10)).toBe(false);
    expect(checkFailureOutcome(malformed, 1, false)).toBeUndefined();
    expect(checkFailureOutcome(malformed, 1, true)).toEqual({
      kind: 'contract_failure', reasonCode: 'output_invalid', stepId: 'validate-plan',
    });
    expect(checkFailureOutcome(malformed, 10, false)).toEqual({
      kind: 'infrastructure_failure', reasonCode: 'configuration', stepId: 'validate-plan',
    });
  });

  it('records timeout categories and validates the reason map vocabulary', () => {
    const timed = { id: 'e2e', onFail: { retry: 'implement', max: 1 }, failureReasons: { '124': 'timeout' as const } };
    expect(checkFailureOutcome(timed, 124, false)).toEqual({
      kind: 'timeout', reasonCode: 'check_timeout', stepId: 'e2e',
    });
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'check', failureReasons: { '2': 'gremlins' } }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'verify', prompt: 'do work', failureReasons: { '1': 'test_regression' } }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'check', failureReasons: { launch: 'configuration' } }).success).toBe(false);
  });
});
