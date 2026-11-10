import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  graphicalSessionOutcomeSchema,
  graphicalSessionRequestAllowed,
  graphicalSessionRequestSchema,
} from '@open-mercato/cezar-contract';

const fixtures = new URL('../../../contract/fixtures/graphical-session/', import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, fixtures), 'utf8')) as unknown;

describe('versioned graphical-session contract', () => {
  it('validates headless and displayed fixtures while preserving generic fields', async () => {
    const headless = await read('headless-request.json');
    const displayed = await read('displayed-request.json');
    expect(graphicalSessionRequestSchema.safeParse(headless).success).toBe(true);
    expect(graphicalSessionRequestSchema.safeParse(displayed).success).toBe(true);
    expect(graphicalSessionRequestSchema.safeParse({ ...displayed as object, schemaVersion: 2 }).success).toBe(false);
    expect(graphicalSessionRequestSchema.safeParse({ ...displayed as object, godotHeadless: true }).success).toBe(false);
  });

  it('distinguishes no-render, offscreen-rendered, and displayed modes', () => {
    const common = { schemaVersion: 1, appEntryPoint: 'app/start' };
    expect(graphicalSessionRequestSchema.safeParse({ ...common, mode: 'headless', renderer: { requirement: 'software' } }).success).toBe(false);
    expect(graphicalSessionRequestSchema.safeParse({ ...common, mode: 'offscreen-rendered' }).success).toBe(false);
    expect(graphicalSessionRequestSchema.safeParse({ ...common, mode: 'displayed', display: { backend: 'auto', width: 1280, height: 720, dpi: 96 } }).success).toBe(false);
    expect(graphicalSessionRequestSchema.safeParse({ ...common, mode: 'offscreen-rendered', renderer: { requirement: 'vulkan' } }).success).toBe(true);
  });

  it('rejects unbounded, unsafe, or contradictory launch requirements', () => {
    const common = { schemaVersion: 1, mode: 'displayed', display: { backend: 'x11', width: 1280, height: 720, dpi: 96 }, renderer: { requirement: 'software' } };
    expect(graphicalSessionRequestSchema.safeParse({ ...common, appEntryPoint: '../outside/app' }).success).toBe(false);
    expect(graphicalSessionRequestSchema.safeParse({ ...common, appEntryPoint: 'C:\\project\\app.exe' }).success).toBe(false);
    expect(graphicalSessionRequestSchema.safeParse({ ...common, appEntryPoint: 'app/start', timeoutMs: 3_600_001 }).success).toBe(false);
  });

  it('requires typed reasons for terminal failures and preserves omitted-session compatibility', async () => {
    const failure = await read('failure-outcome.json');
    expect(graphicalSessionOutcomeSchema.safeParse(failure).success).toBe(true);
    expect(graphicalSessionOutcomeSchema.safeParse({ schemaVersion: 1, sessionId: 's', status: 'failed' }).success).toBe(false);
    const displayed = graphicalSessionRequestSchema.parse(await read('displayed-request.json'));
    expect(graphicalSessionRequestAllowed(false, undefined)).toBe(true);
    expect(graphicalSessionRequestAllowed(false, displayed)).toBe(false);
    expect(graphicalSessionRequestAllowed(true, displayed)).toBe(true);
  });
});
