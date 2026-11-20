import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSession, ContentBlock } from '../../src/core/agent-runner.js';
import {
  AgentSessionContinuation,
  createSessionContinuation,
  SESSION_CONTINUATION_CAPABILITIES,
  type AgentSessionRef,
} from '../../src/core/session-continuation.js';

function fakeSession() {
  let open = true;
  const messages: ContentBlock[][] = [];
  const session: Pick<AgentSession, 'open' | 'sendMessage'> = {
    get open() {
      return open;
    },
    sendMessage(content) {
      if (!open) return false;
      messages.push(content);
      return true;
    },
  };
  return { session, messages, close: () => (open = false) };
}

const ref: AgentSessionRef = {
  runId: 'run-1',
  stepId: 'implement',
  sessionId: 'provider-session-1',
  backend: 'claude',
  origin: 'started',
  worktree: 'D:/worktrees/issue-737',
  profileId: 'default',
  modelIdentity: 'anthropic/claude-sonnet',
  issueNumber: 737,
};

test('three repair turns use one live session reference and preserve provider context', () => {
  const provider = fakeSession();
  const continuation = new AgentSessionContinuation(ref, provider.session, SESSION_CONTINUATION_CAPABILITIES.claude);

  for (let round = 1; round <= 3; round++) {
    const key = `repair-${round}`;
    assert.deepEqual(continuation.continueSession(`Finding delta for round ${round}`, key), { status: 'sent', round });
    assert.equal(continuation.completeTurn(key), true);
  }

  assert.equal(continuation.ref.sessionId, ref.sessionId);
  assert.equal(continuation.ref.worktree, ref.worktree);
  assert.equal(continuation.ref.profileId, ref.profileId);
  assert.equal(continuation.ref.modelIdentity, ref.modelIdentity);
  assert.equal(Object.isFrozen(continuation.ref), true);
  assert.deepEqual(
    provider.messages.map((blocks) => blocks.map((block) => (block.type === 'text' ? block.text : 'image'))),
    [
      ['Finding delta for round 1'],
      ['Finding delta for round 2'],
      ['Finding delta for round 3'],
    ],
  );
  assert.deepEqual(continuation.metrics, {
    sessionStarts: 1,
    sessionResumptions: 0,
    continuationTurns: 3,
    duplicateRequests: 0,
  });

  const resumed = new AgentSessionContinuation(
    { ...ref, origin: 'resumed' },
    fakeSession().session,
    SESSION_CONTINUATION_CAPABILITIES.claude,
  );
  assert.deepEqual(resumed.metrics, {
    sessionStarts: 0,
    sessionResumptions: 1,
    continuationTurns: 0,
    duplicateRequests: 0,
  });
});

test('idempotency prevents duplicate sends and a session admits only one pending continuation', () => {
  const provider = fakeSession();
  const continuation = new AgentSessionContinuation(ref, provider.session, SESSION_CONTINUATION_CAPABILITIES.codex);

  assert.deepEqual(continuation.continueSession('diagnostic delta', 'attempt-1'), { status: 'sent', round: 1 });
  assert.deepEqual(continuation.continueSession('diagnostic delta', 'attempt-1'), { status: 'duplicate', round: 1 });
  assert.deepEqual(continuation.continueSession('next round', 'attempt-2'), { status: 'busy', activeKey: 'attempt-1' });
  assert.equal(provider.messages.length, 1);
  assert.equal(continuation.completeTurn('wrong-key'), false);
  assert.equal(continuation.completeTurn('attempt-1'), true);
  assert.deepEqual(continuation.continueSession('next round', 'attempt-2'), { status: 'sent', round: 2 });
  assert.equal(continuation.metrics.duplicateRequests, 1);
});

test('unsupported or closed providers report an explicit terminal capability result', () => {
  const provider = fakeSession();
  const cursor = new AgentSessionContinuation(ref, provider.session, SESSION_CONTINUATION_CAPABILITIES.cursor);
  assert.deepEqual(cursor.continueSession('repair', 'cursor-1'), {
    status: 'unsupported',
    reason: 'print mode exits after its first result',
  });
  assert.equal(provider.messages.length, 0);

  const claude = new AgentSessionContinuation(ref, provider.session, SESSION_CONTINUATION_CAPABILITIES.claude);
  provider.close();
  assert.equal(claude.continueSession('repair', 'claude-1').status, 'session_unavailable');
  assert.equal(provider.messages.length, 0);
});

test('provider continuation capabilities distinguish live, native-resume, and runtime-resume support', () => {
  assert.deepEqual(SESSION_CONTINUATION_CAPABILITIES.opencode, {
    live: true,
    processResume: 'unsupported',
    reason: 'the runner creates a new server-side session',
  });
  assert.equal(SESSION_CONTINUATION_CAPABILITIES.copilot.processResume, 'runtime');
  assert.equal(SESSION_CONTINUATION_CAPABILITIES.cursor.live, false);
  assert.equal(SESSION_CONTINUATION_CAPABILITIES.codex.processResume, 'native');
});

test('runner-bound controller selects capabilities from the owning adapter', () => {
  const provider = fakeSession();
  const continuation = createSessionContinuation(
    { backend: 'cursor' },
    {
      runId: ref.runId,
      stepId: ref.stepId,
      sessionId: ref.sessionId,
      origin: 'started',
      worktree: ref.worktree,
    },
    provider.session,
  );

  assert.equal(continuation.ref.backend, 'cursor');
  assert.equal(continuation.continueSession('delta', 'attempt-1').status, 'unsupported');
  assert.equal(provider.messages.length, 0);
});
