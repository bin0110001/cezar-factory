import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  SESSION_CONTROL_LIMITS,
  sessionControlActionAllowed,
  sessionControlRateLimited,
  sessionControlRequestSchema,
  sessionControlResponseSchema,
  type SessionControlAction,
} from '@open-mercato/cezar-contract';

const fixtures = new URL('../../../contract/fixtures/session-control/', import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, fixtures), 'utf8')) as unknown;

describe('versioned session-control contract', () => {
  it('validates observe/control action fixtures and rejects unsupported versions or unsafe navigation', async () => {
    const metadata = await read('metadata-request.json');
    const click = await read('click-request.json');
    expect(sessionControlRequestSchema.safeParse(metadata).success).toBe(true);
    expect(sessionControlRequestSchema.safeParse(click).success).toBe(true);
    expect(sessionControlRequestSchema.safeParse({ ...metadata as object, schemaVersion: 2 }).success).toBe(false);
    expect(sessionControlRequestSchema.safeParse({
      schemaVersion: 1, requestId: 'r', sessionId: 's', action: { type: 'navigate', url: 'javascript:alert(1)' },
    }).success).toBe(false);
    expect(sessionControlRequestSchema.safeParse({
      schemaVersion: 1, requestId: 'r', sessionId: 's', action: { type: 'click', target: { kind: 'role', value: 'button' }, extra: true },
    }).success).toBe(false);
  });

  it('denies input to observe-only grants using trusted capability state', async () => {
    const metadata = sessionControlRequestSchema.parse(await read('metadata-request.json'));
    const click = sessionControlRequestSchema.parse(await read('click-request.json'));
    expect(sessionControlActionAllowed('observe', metadata.action)).toBe(true);
    expect(sessionControlActionAllowed('observe', click.action)).toBe(false);
    expect(sessionControlActionAllowed('control', click.action)).toBe(true);
    const denied = await read('denied-control-response.json');
    expect(sessionControlResponseSchema.safeParse(denied).success).toBe(true);
  });

  it('bounds arguments, success payloads, errors, and request rate policy', () => {
    expect(sessionControlRequestSchema.safeParse({
      schemaVersion: 1, requestId: 'r', sessionId: 's', action: { type: 'type', target: { kind: 'testId', value: 'search' }, text: 'x'.repeat(SESSION_CONTROL_LIMITS.maxTextInput + 1) },
    }).success).toBe(false);
    expect(sessionControlResponseSchema.safeParse({
      ok: true, schemaVersion: 1, requestId: 'r', sessionId: 's',
      result: { kind: 'accessibilitySnapshot', truncated: false, nodes: Array.from({ length: 500 }, (_, i) => ({ id: `${i}`, role: 'button', name: 'n'.repeat(SESSION_CONTROL_LIMITS.maxSnapshotText) })) },
    }).success).toBe(false);
    expect(sessionControlResponseSchema.safeParse({
      ok: false, schemaVersion: 1, requestId: 'r', sessionId: 's', error: { code: 'lost_worker', message: 'x'.repeat(513) },
    }).success).toBe(false);
    expect(sessionControlRateLimited(SESSION_CONTROL_LIMITS.maxRequestsPerMinute - 1)).toBe(false);
    expect(sessionControlRateLimited(SESSION_CONTROL_LIMITS.maxRequestsPerMinute)).toBe(true);
    expect(sessionControlRateLimited(Number.NaN)).toBe(true);
  });

  it('keeps the action union exhaustive for TypeScript consumers', () => {
    const action: SessionControlAction = { type: 'scroll', deltaX: 0, deltaY: 200 };
    expect(sessionControlActionAllowed('observe', action)).toBe(false);
  });
});
