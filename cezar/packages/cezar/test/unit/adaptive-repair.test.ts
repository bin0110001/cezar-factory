import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adaptiveRepairFeedback, parseAdaptiveRepairDecision, worktreeArtifactRevision } from '../../src/workflows/adaptive-repair.js';

test('adaptive repair parses only versioned decisions and formats focused bounded feedback', () => {
  const decision = parseAdaptiveRepairDecision({
    schemaVersion: 1,
    action: 'repair',
    feedback: [{ checkId: 'unit', category: 'code-defect', disposition: 'repair', message: 'missing fields\nfix them' }],
    summary: { entries: [{ findingId: 'finding-a', message: 'status conflict' }] },
  });
  const feedback = adaptiveRepairFeedback(decision);
  assert.match(feedback, /unit \(code-defect\), repair: missing fields fix them/);
  assert.match(feedback, /finding-a: status conflict/);
  assert.throws(() => parseAdaptiveRepairDecision({ schemaVersion: 2, action: 'repair' }));
  assert.throws(() => adaptiveRepairFeedback(parseAdaptiveRepairDecision({ schemaVersion: 1, action: 'repair' })));
});

test('artifact revision changes for staged, unstaged, deleted and untracked source files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-adaptive-revision-'));
  try {
    const run = (args: string[]) => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    run(['init', '-q', '-b', 'main']);
    writeFileSync(join(root, 'tracked.txt'), 'base\n');
    run(['add', 'tracked.txt']);
    run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'base']);
    const base = worktreeArtifactRevision(root);
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');
    assert.notEqual(worktreeArtifactRevision(root), base);
    run(['add', 'tracked.txt']);
    assert.notEqual(worktreeArtifactRevision(root), base);
    run(['checkout', '--', 'tracked.txt']);
    rmSync(join(root, 'tracked.txt'));
    assert.notEqual(worktreeArtifactRevision(root), base);
    writeFileSync(join(root, 'new.txt'), 'new\n');
    assert.notEqual(worktreeArtifactRevision(root), base);
    mkdirSync(join(root, '.factory'));
    writeFileSync(join(root, '.factory', 'ignored.json'), '{}');
    run(['config', 'core.excludesfile', join(root, 'ignore')]);
    writeFileSync(join(root, 'ignore'), '.factory/\n');
    assert.match(worktreeArtifactRevision(root), /^sha256:[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
