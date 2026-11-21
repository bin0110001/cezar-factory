import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { versionedWorkflowSchema } from '@open-mercato/cezar-contract';
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

  it('keeps the shared lifecycle stage catalog on the versioned Cezar contract', () => {
    let factoryRoot = resolve(process.cwd());
    while (!existsSync(join(factoryRoot, 'workflows', 'lifecycle-intake.workflow.json'))) {
      const parent = dirname(factoryRoot);
      if (parent === factoryRoot) throw new Error('Factory shared workflow catalog was not found from the test working directory');
      factoryRoot = parent;
    }
    const catalog = join(factoryRoot, 'workflows');
    const files = readdirSync(catalog).filter((file) => file.endsWith('.workflow.json') && file.startsWith('lifecycle-'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const parsed = versionedWorkflowSchema.safeParse(JSON.parse(readFileSync(join(catalog, file), 'utf8')));
      expect(parsed.success, file).toBe(true);
    }
  });
});
