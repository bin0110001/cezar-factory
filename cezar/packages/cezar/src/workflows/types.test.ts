import { describe, expect, it } from 'vitest';
import { stepsIssue, workflowStepSchema, type WorkflowStepDef } from './types.ts';

function agent(id: string, retry: string): WorkflowStepDef {
  return workflowStepSchema.parse({ id, prompt: 'work', onFail: { retry, max: 1 } });
}

function check(id: string, retry?: string): WorkflowStepDef {
  return workflowStepSchema.parse({
    id,
    command: 'true',
    ...(retry ? { onFail: { retry, max: 1 } } : {}),
  });
}

describe('workflow onFail targets', () => {
  it('allows failed agent steps to route forward to a bounded recovery check', () => {
    expect(stepsIssue([agent('investigate', 'validate'), check('validate')])).toBeNull();
  });

  it('keeps check-step retries backward-only and requires every recovery target to exist', () => {
    expect(stepsIssue([check('validate', 'recover'), agent('recover', 'absent')])).toContain('earlier step');
    expect(stepsIssue([agent('investigate', 'absent')])).toContain('existing step');
    expect(stepsIssue([agent('investigate', 'recover'), agent('recover', 'investigate')])).toContain('forward recovery target must be a check step');
  });
});
