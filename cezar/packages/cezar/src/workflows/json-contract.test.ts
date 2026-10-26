import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { checkFailureOutcome, normalizeWorkflowDoc, shouldRetryCheck, stepsIssue, validateWorkflowContract, validateWorkflowOutput, workflowConditionMatches, workflowControlOf, workflowDefSchema, workflowFileSchema, workflowStepSchema } from './types.ts';

const factoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');

describe('workflow JSON contracts', () => {
  it('carries the shared repair budget through file parsing and applies the three-repair default', () => {
    const steps = [{ id: 'implement', prompt: '{{task}}' }];
    const parsedDefault = workflowFileSchema.parse({ name: 'default-budget', steps });
    const parsedConfigured = workflowFileSchema.parse({ name: 'configured-budget', maxRepairAttempts: 5, steps });

    expect(normalizeWorkflowDoc(parsedDefault).maxRepairAttempts).toBe(3);
    expect(workflowDefSchema.parse({ ...normalizeWorkflowDoc(parsedDefault), source: 'file' }).maxRepairAttempts).toBe(3);
    expect(normalizeWorkflowDoc(parsedConfigured).maxRepairAttempts).toBe(5);
    expect(workflowDefSchema.parse({ ...normalizeWorkflowDoc(parsedConfigured), source: 'file' }).maxRepairAttempts).toBe(5);
  });

  it.each(['plan.yaml', 'maintenance.yaml', 'implement.yaml', 'investigate.yaml', 'fix-review.yaml'])('loads Factory workflow %s output contracts as valid definitions', (file) => {
    const parsed = workflowFileSchema.safeParse(parseYaml(readFileSync(join(factoryRoot, 'workflows', file), 'utf8')));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const normalized = normalizeWorkflowDoc(parsed.data);
    expect(stepsIssue(normalized.steps)).toBeNull();
    expect(workflowDefSchema.safeParse({ ...normalized, source: 'file' }).success).toBe(true);
    const isPlanner = file === 'plan.yaml';
    const isMaintenance = file === 'maintenance.yaml';
    const isImplementation = file === 'implement.yaml';
    const outputStep = normalized.steps.find((step) => step.outputSchema && (step.skill || step.prompt));
    if (isPlanner || isMaintenance || isImplementation) {
      expect(outputStep).toBeDefined();
      const value = isPlanner
        ? {
          issue: 12, objective: 'Bounded planning', acceptanceCriteria: 'The plan is actionable.',
          nonGoals: 'No implementation', risks: 'Review decomposition', dependencies: 'None',
          suggestedWorkBreakdown: 'Inspect, implement, verify', requiredProjectSkills: [],
          unresolvedQuestions: '', complexity: 'complexity:medium', readyNotReadyStatus: 'ready',
          }
        : isMaintenance
          ? {
          considered: [12],
          changed: [{ issue: 12, added: ['factory:new', 'type:feature', 'risk:medium'], reason: 'feature request' }],
          skipped: [],
            }
          : {
            issue: 12, status: 'failure', summary: 'implementation failed', filesChanged: [], testsRun: [],
            testResult: 'not-run', acceptanceCriteriaStatus: 'Not met', documentationUpdated: false,
            knownConcerns: 'missing prerequisite', followUpSuggestions: '', durableKnowledgeCandidates: '',
            };
      const invalid = isPlanner
        ? { ...value, complexity: 'incorrect' }
        : isMaintenance
          ? { ...value, changed: [{ issue: 12, added: ['factory:unsafe'], reason: 'invalid proposal' }] }
          : { ...value, unexpected: true };
      const validResult = validateWorkflowContract(outputStep!.outputSchema!, value);
      expect(validResult, JSON.stringify(validResult)).toMatchObject({ success: true });
      expect(validateWorkflowContract(outputStep!.outputSchema!, invalid).success).toBe(false);
    }

    const preflightId = isMaintenance ? 'backlog-label-audit-prepare' : 'resolved';
    const preflightStep = normalized.steps.find((step) => step.id === preflightId);
    expect(preflightStep?.outputSchema).toBeDefined();
    const preflightValues = isMaintenance
      ? [
          { status: 'prepared', candidateCount: 0, resolvedCount: 2, $cezar: { action: 'no_work', reasonCode: 'no_work' } },
          { status: 'prepared', candidateCount: 2, resolvedCount: 1 },
        ]
      : [
          { status: 'open', issue: 12 },
          { status: 'already-resolved', issue: 12, $cezar: { action: 'no_work', reasonCode: 'no_work' } },
        ];
    for (const preflightValue of preflightValues) {
      const result = validateWorkflowContract(preflightStep!.outputSchema!, preflightValue);
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    }
  });

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

  it('requires an agent output contract to be followed by a step that closes its session', () => {
    const outputSchema = { type: 'object', required: ['proposal'], properties: { proposal: { type: 'string' } } };
    expect(workflowDefSchema.safeParse({
      name: 'interactive-agent-output', source: 'file',
      steps: [{ id: 'proposal', prompt: 'return JSON', outputSchema }],
    }).success).toBe(false);
    expect(workflowDefSchema.safeParse({
      name: 'agent-output', source: 'file',
      steps: [{ id: 'proposal', prompt: 'return JSON', outputSchema }, { id: 'apply', command: 'apply' }],
    }).success).toBe(true);
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

  it('retries implementation only for explicitly classified test regressions', () => {
    const parsed = workflowFileSchema.parse(parseYaml(readFileSync(join(factoryRoot, 'workflows', 'implement.yaml'), 'utf8')));
    const steps = normalizeWorkflowDoc(parsed).steps;
    for (const id of ['targeted-tests', 'full-verification', 'verify-project']) {
      const step = steps.find((candidate) => candidate.id === id)!;
      expect(step.onFail?.retryOn).toEqual([1]);
      expect(step.failureReasons).toMatchObject({
        '1': 'test_regression', '10': 'configuration', '11': 'missing_command',
        '12': 'authentication', '13': 'provider_unavailable', '14': 'provider_quota',
        '15': 'transient_transport', '16': 'timeout', '17': 'malformed_result', '18': 'unknown',
      });
      expect(shouldRetryCheck(step, 1)).toBe(true);
      for (const code of [10, 11, 12, 13, 14, 15, 16, 17, 18]) expect(shouldRetryCheck(step, code)).toBe(false);
      expect(checkFailureOutcome(step, 18, false)).toMatchObject({ kind: 'infrastructure_failure', reasonCode: 'unknown' });
    }
  });

  it('retries fix-review only for classified verification or agent-result defects', () => {
    const parsed = workflowFileSchema.parse(parseYaml(readFileSync(join(factoryRoot, 'workflows', 'fix-review.yaml'), 'utf8')));
    const steps = normalizeWorkflowDoc(parsed).steps;
    const tests = steps.find((candidate) => candidate.id === 'targeted-tests')!;
    expect(tests.onFail?.retryOn).toEqual([1]);
    expect(tests.failureReasons).toMatchObject({
      '1': 'test_regression', '10': 'configuration', '11': 'missing_command',
      '12': 'authentication', '13': 'provider_unavailable', '14': 'provider_quota',
      '15': 'transient_transport', '16': 'timeout', '17': 'malformed_result', '18': 'unknown',
    });
    expect(shouldRetryCheck(tests, 1)).toBe(true);
    for (const code of [10, 11, 12, 13, 14, 15, 16, 17, 18]) expect(shouldRetryCheck(tests, code)).toBe(false);

    const validate = steps.find((candidate) => candidate.id === 'validate')!;
    expect(validate.onFail?.retryOn).toEqual([1]);
    expect(validate.failureReasons).toEqual({ '1': 'work_verdict' });
    expect(shouldRetryCheck(validate, 1)).toBe(true);
    expect(checkFailureOutcome(validate, 1, true)).toMatchObject({ kind: 'task_failure', reasonCode: 'work_verdict' });
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
