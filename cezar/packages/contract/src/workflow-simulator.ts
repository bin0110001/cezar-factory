import {
  canonicalJson,
  selectWorkflowTransition,
  type VersionedWorkflow,
  type WorkflowOutcome,
} from './versioned-workflows.ts';
import { workflowSimulationRequestSchema, workflowSimulationResponseSchema, type WorkflowSimulationRequest, type WorkflowSimulationResponse } from './workflow-simulation.ts';

async function digest(value: unknown): Promise<string> {
  const bytes = [...unescape(encodeURIComponent(canonicalJson(value)))].map((char) => char.charCodeAt(0));
  const webCrypto = (globalThis as unknown as { crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto;
  if (!webCrypto?.subtle) throw new Error('SHA-256 is unavailable in this runtime');
  const hash = await webCrypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Run explicit fixtures against a graph without dispatching workers, effects, or child runs. */
export async function simulateWorkflow(input: WorkflowSimulationRequest, activePinnedRuns = 0): Promise<WorkflowSimulationResponse> {
  const request = workflowSimulationRequestSchema.parse(input);
  const workflow = request.workflow;
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const scenarios = request.scenarios.map((scenario) => {
    let current = workflow.entry;
    const counts: Record<string, number> = {};
    const outcomes: Record<string, string> = {};
    const steps: WorkflowSimulationResponse['scenarios'][number]['steps'] = [];
    const path: string[] = [];
    for (let index = 0; index < scenario.maxSteps; index++) {
      const node = nodes.get(current)!;
      if (workflow.terminals.includes(current)) {
        const outcome = node.kind === 'return' ? outcomes[node.source] : outcomes[current];
        return { id: scenario.id, status: 'completed' as const, steps, terminal: current, ...(outcome ? { outcome: outcome as WorkflowSimulationResponse['scenarios'][number]['outcome'] } : {}) };
      }
      path.push(current);
      let outcome: WorkflowOutcome | undefined = node.kind === 'return' ? outcomes[node.source] as WorkflowOutcome | undefined : undefined;
      if (node.kind === 'wait') {
        const trigger = scenario.waitTriggers[current];
        const matches = trigger && ((node.waitFor === 'human' && trigger.kind === 'human')
          || (node.waitFor === 'event' && trigger.kind === 'event' && trigger.event === node.event)
          || (node.waitFor === 'time' && trigger.kind === 'time' && Date.parse(trigger.now) >= Date.parse(node.resumeAt!)));
        if (!matches) {
          steps.push({ node: current, kind: node.kind, note: 'waiting for an explicit matching fixture trigger' });
          return { id: scenario.id, status: 'waiting' as const, steps, terminal: current, reason: node.reason };
        }
        outcome = node.outcomes[0];
      }
      if (!outcome) {
        const visit = counts[current] ?? 0;
        outcome = scenario.outcomes[current]?.[visit] as WorkflowOutcome | undefined;
        counts[current] = visit + 1;
      }
      if (!outcome || !node.outcomes.includes(outcome)) {
        steps.push({ node: current, kind: node.kind, note: outcome ? `fixture outcome "${outcome}" is not declared by this node` : 'no explicit outcome fixture supplied' });
        return { id: scenario.id, status: outcome ? 'failed' as const : 'unknown' as const, steps, reason: 'simulation requires an explicit declared node outcome' };
      }
      outcomes[current] = outcome;
      if (node.kind === 'return') outcomes[current] = outcome;
      const route = selectWorkflowTransition(workflow, current, outcome, { outcomes, inputs: scenario.inputs });
      if (route.status !== 'selected') {
        steps.push({ node: current, kind: node.kind, outcome, guard: route.status, note: route.reason });
        return { id: scenario.id, status: route.status === 'unknown' ? 'unknown' as const : 'failed' as const, steps, reason: route.reason };
      }
      steps.push({ node: current, kind: node.kind, outcome, to: route.to, guard: 'selected', ...(node.kind === 'fork' || node.kind === 'join' || node.kind === 'child_workflow' ? { note: 'simulated from fixture; no child or worker was started' } : {}) });
      current = route.to;
    }
    const tail = path.slice(-Math.min(path.length, 64));
    const repeatedAt = tail.findIndex((node, index) => tail.indexOf(node) !== index);
    const cycleWitness = repeatedAt >= 0 ? [...tail.slice(repeatedAt), tail[repeatedAt]] : tail.slice(-2);
    return { id: scenario.id, status: 'budget-exhausted' as const, steps, cycleWitness, reason: `maxSteps (${scenario.maxSteps}) reached` };
  });
  const changes: Array<{ category: 'identity' | 'reachability' | 'permissions' | 'required-gates' | 'budget' | 'compatibility' | 'github-projections' | 'definition'; beforeDigest: string; afterDigest: string }> = [];
  if (request.compareTo) {
    const before = request.compareTo;
    const after = workflow;
    const categories = [
      ['identity', (graph: VersionedWorkflow) => ({ id: graph.id, version: graph.version })],
      ['reachability', (graph: VersionedWorkflow) => ({ entry: graph.entry, terminals: graph.terminals, edges: graph.transitions.map(({ from, outcome, to, when, order }) => ({ from, outcome, to, when, order })) })],
      ['permissions', (graph: VersionedWorkflow) => ({ capabilities: graph.capabilities, nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind, capabilities: node.kind === 'action' ? node.capabilities : [], resources: node.resources })) })],
      ['required-gates', (graph: VersionedWorkflow) => graph.nodes.filter((node) => node.kind === 'policy_gate' || node.kind === 'verification' || node.kind === 'validator').map((node) => ({ id: node.id, kind: node.kind }))],
      ['budget', (graph: VersionedWorkflow) => ({ budget: graph.budget, nodes: graph.nodes.map((node) => ({ id: node.id, retry: node.retry, timeoutSeconds: node.timeoutSeconds })) })],
      ['compatibility', (graph: VersionedWorkflow) => graph.compatibility],
      ['github-projections', (graph: VersionedWorkflow) => graph.nodes.filter((node) => graph.terminals.includes(node.id)).map((node) => ({ terminal: node.id, outcomes: node.outcomes }))],
      ['definition', (graph: VersionedWorkflow) => graph],
    ] as const;
    for (const [category, project] of categories) {
      const beforeValue = project(before);
      const afterValue = project(after);
      const beforeDigest = await digest(beforeValue);
      const afterDigest = await digest(afterValue);
      if (beforeDigest !== afterDigest) changes.push({ category, beforeDigest, afterDigest });
    }
  }
  return workflowSimulationResponseSchema.parse({ schemaVersion: 1, workflow: { id: workflow.id, version: workflow.version, digest: await digest(workflow) }, scenarios, ...(request.compareTo ? { comparison: { changes, activePinnedRuns, migration: 'none' } } : {}) });
}
