import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRE_READY_LANE_LABELS } from '../automations/scheduler.ts';
import { DECISION_STATES, RESUME_STATE } from './decisions/decisions.ts';

interface PolicyState { kind: string; lane?: string; exits?: Array<{ to: string; on: string }> }
const policy = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../policies/lifecycle.json'), 'utf8')) as {
  profiles: { standard: { states: Record<string, PolicyState> } };
};
const states = policy.profiles.standard.states;

// Cezar keeps a few product copies of the lifecycle (STABILIZATION-PLAN.md item 1.4f). Until they read the policy at
// run time, these tests fail when one of them drifts from it.
describe('Cezar copies of the Factory lifecycle agree with policies/lifecycle.json', () => {
  it('the scheduler gate lists exactly the states in the Inbox and Refinement lanes', () => {
    const preReady = Object.entries(states).filter(([, s]) => s.lane === 'Inbox' || s.lane === 'Refinement').map(([label]) => label);
    expect([...PRE_READY_LANE_LABELS].sort()).toEqual(preReady.sort());
  });

  it('decisions are raised in the human states that a person can send back to the resume state', () => {
    const decisionStates = Object.entries(states).filter(([label, s]) => s.kind === 'human' && label !== 'factory:blocked').map(([label]) => label);
    expect([...DECISION_STATES].sort()).toEqual(decisionStates.sort());
    for (const label of DECISION_STATES) expect(states[label]?.exits?.some((exit) => exit.to === RESUME_STATE)).toBe(true);
  });
});
