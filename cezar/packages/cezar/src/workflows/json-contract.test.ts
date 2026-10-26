import { describe, expect, it } from 'vitest';
import { validateWorkflowContract, validateWorkflowOutput, workflowConditionMatches, workflowControlOf, workflowStepSchema } from './types.ts';

describe('workflow JSON contracts', () => {
  it('accepts values matching a standard JSON Schema', () => {
    expect(validateWorkflowContract(
      { type: 'object', required: ['count'], properties: { count: { type: 'integer' } }, additionalProperties: false },
      { count: 3 },
    )).toEqual({ success: true, data: { count: 3 } });
  });

  it('rejects missing and malformed values as contract failures', () => {
    expect(validateWorkflowContract(
      { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
      {},
    )).toMatchObject({ success: false, failure: 'value_invalid' });
    expect(validateWorkflowContract({ type: 'made-up-type' }, {})).toMatchObject({ success: false, failure: 'schema_invalid' });
  });

  it('accepts input and output schemas only on workflow step definitions', () => {
    const parsed = workflowStepSchema.safeParse({
      id: 'collect', command: 'collect-json',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
    });
    expect(parsed.success).toBe(true);
  });

  it('uses a standard JSON Schema condition to select whether a step applies', () => {
    const condition = { type: 'object', required: ['outputs'], properties: {
      outputs: { type: 'object', required: ['preflight'], properties: {
        preflight: { type: 'object', required: ['hasWork'], properties: { hasWork: { const: true } } },
      } },
    } };
    expect(workflowStepSchema.safeParse({ id: 'implement', prompt: 'do it', when: condition }).success).toBe(true);
    expect(workflowConditionMatches(condition, { task: 'fix issue', outputs: { preflight: { hasWork: true } } })).toBe(true);
    expect(workflowConditionMatches(condition, { task: 'fix issue', outputs: { preflight: { hasWork: false } } })).toBe(false);
    expect(workflowConditionMatches(undefined, { task: 'fix issue', outputs: {} })).toBe(true);
  });

  it('rejects an invalid condition schema at workflow definition validation', () => {
    expect(workflowStepSchema.safeParse({ id: 'implement', prompt: 'do it', when: { type: 'not-a-json-schema-type' } }).success).toBe(false);
  });

  it('recognizes only typed reserved control outcomes', () => {
    expect(workflowControlOf({ $cezar: { action: 'no_work', reasonCode: 'no_work' } })).toEqual({
      control: { action: 'no_work', reasonCode: 'no_work' },
    });
    expect(workflowControlOf({ $cezar: { action: 'skip_step', reasonCode: 'no_work' } }).error).toContain('precondition_not_met');
    expect(workflowControlOf({ $cezar: { action: 'blocked', reasonCode: 'provider_quota' } }).control?.action).toBe('blocked');
  });

  it('classifies missing, malformed, invalid, and schema-invalid check output', () => {
    const schema = { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } };
    expect(validateWorkflowOutput('  ', schema)).toMatchObject({ success: false, failure: 'output_missing' });
    expect(validateWorkflowOutput('{', schema)).toMatchObject({ success: false, failure: 'output_malformed' });
    expect(validateWorkflowOutput('{"count":"no"}', schema)).toMatchObject({ success: false, failure: 'output_invalid' });
    expect(validateWorkflowOutput('{"count":1}', { type: 'unknown-schema' })).toMatchObject({ success: false, failure: 'output_schema_invalid' });
  });

  it('returns only schema-validated data and typed control envelopes', () => {
    const schema = { type: 'object', required: ['$cezar'], properties: { $cezar: { type: 'object' } } };
    expect(validateWorkflowOutput('{"$cezar":{"action":"no_work","reasonCode":"no_work"}}', schema))
      .toMatchObject({ success: true, data: { $cezar: { action: 'no_work', reasonCode: 'no_work' } }, control: { action: 'no_work', reasonCode: 'no_work' } });
    expect(validateWorkflowOutput('{"$cezar":{"action":"no_work","reasonCode":"wrong"}}', schema))
      .toMatchObject({ success: false, failure: 'output_invalid' });
  });
});
