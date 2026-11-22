import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { simulateWorkflow, workflowSimulationRequestSchema } from '@open-mercato/cezar-contract';

export async function runWorkflowSimulationCommand(args: string[]): Promise<number> {
  const path = args[0];
  if (!path || args.length !== 1) {
    console.error('Usage: cezar workflow simulate <request.json>');
    return 2;
  }
  try {
    const request = workflowSimulationRequestSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
    console.log(JSON.stringify(await simulateWorkflow(request), null, 2));
    return 0;
  } catch (error) {
    console.error(`Workflow simulation failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
