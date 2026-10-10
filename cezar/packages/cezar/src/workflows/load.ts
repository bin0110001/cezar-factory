import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sharedDirs } from '../shared-dirs.ts';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  stepsIssue,
  workflowFileSchema,
  type WorkflowDef,
} from './types.ts';

export const WORKFLOWS_DIR = '.ai/cezar/workflows';

export interface WorkflowLoadIssue {
  path: string;
  message: string;
}

/**
 * Load the workflow catalog: the built-in `quick-task` plus every
 * `.ai/cezar/workflows/*.{yaml,yml}` in the repo. File workflows win name
 * collisions with built-ins. Invalid files are reported, never fatal.
 *
 * Operators can also mount shared catalogs (`CEZ_SHARED_WORKFLOWS_DIRS`, e.g. the Factory
 * checkout's `workflows/`), loaded after the repo's own files: a workflow in the repo with the
 * same name always wins, so a project can override a shared one.
 */
export async function loadWorkflows(
  repoRoot: string,
): Promise<{ workflows: WorkflowDef[]; issues: WorkflowLoadIssue[] }> {
  const issues: WorkflowLoadIssue[] = [];
  const fromFiles: WorkflowDef[] = [];
  const dirs = [resolve(repoRoot, WORKFLOWS_DIR), ...sharedDirs('CEZ_SHARED_WORKFLOWS_DIRS')];
  const seenNames = new Set<string>();

  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      // no workflows dir — built-ins only
    }

    for (const entry of entries.sort()) {
      const ext = extname(entry).toLowerCase();
      if (ext !== '.yaml' && ext !== '.yml') continue;
      const path = join(dir, entry);
      try {
        const raw = await readFile(path, 'utf8');
        const parsed = workflowFileSchema.safeParse(parseYaml(raw));
        if (!parsed.success) {
          issues.push({ path, message: parsed.error.issues.map((i) => i.message).join('; ') });
          continue;
        }
        // `skills:` shorthand files become plain agent steps here (spec 012).
        const normalized = normalizeWorkflowDoc(parsed.data);
        // Steps referenced by onFail.retry must exist and come earlier; ids unique.
        const issue = stepsIssue(normalized.steps);
        if (issue) {
          issues.push({ path, message: issue });
          continue;
        }
        // Earlier directories (the repo's own) shadow later (shared) ones of the same name.
        if (seenNames.has(normalized.name)) continue;
        seenNames.add(normalized.name);
        fromFiles.push({ ...normalized, source: 'file', path });
      } catch (err) {
        issues.push({ path, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const fileNames = new Set(fromFiles.map((w) => w.name));
  const workflows = [
    ...fromFiles,
    ...[QUICK_TASK_WORKFLOW].filter((w) => !fileNames.has(w.name)),
  ];
  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return { workflows, issues };
}
