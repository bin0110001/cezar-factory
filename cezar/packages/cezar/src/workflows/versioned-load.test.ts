import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadVersionedWorkflows } from './load.ts';

describe('versioned workflow catalog', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('loads pinned id/version definitions and reports invalid files without changing the legacy loader', async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-versioned-workflows-'));
    const workflowsDir = join(root, '.ai', 'cezar', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const workflow = {
      contract: 'cezar.workflow', schemaVersion: 1, id: 'issue-repair', version: '1.2.0',
      entry: 'implement', terminals: ['done'],
      nodes: [
        { id: 'implement', kind: 'agent', prompt: 'Implement {{task}}', outcomes: ['passed'] },
        { id: 'done', kind: 'wait', reason: 'Complete', outcomes: ['passed'] },
      ],
      transitions: [{ from: 'implement', outcome: 'passed', to: 'done', order: 0 }],
      compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '1.99.99' },
    };
    writeFileSync(join(workflowsDir, 'issue-repair.workflow.json'), JSON.stringify(workflow));
    writeFileSync(join(workflowsDir, 'broken.workflow.json'), '{not json');
    writeFileSync(join(workflowsDir, 'legacy.yaml'), 'name: legacy\nskills: [plan]\n');

    const loaded = await loadVersionedWorkflows(root);
    expect(loaded.workflows.map(({ id, version }) => [id, version])).toEqual([['issue-repair', '1.2.0']]);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.path).toContain('broken.workflow.json');
  });
});
