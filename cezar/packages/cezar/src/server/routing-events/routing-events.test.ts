import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRoutingEvent, ROUTING_STATES } from './event.ts';
import { redactEvent, redactLogPayload, safeLogger } from './redact.ts';
import { RoutingEventStore } from './store.ts';
import { emitRoutingEvent, setRoutingEventSinks, storeSink } from './emit.ts';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'routing-events-')), 'events.jsonl');
const CANARIES = ['sk-CANARYSECRET123456', 'ghp_CANARYTOKEN123456', 'Bearer abcdef1234567890XYZ', 'TOPSECRET-PROMPT-TEXT'];
const base = { runId: 'run-1', attempt: 1, state: 'routed', selected: { model: 'gpt-x', tier: 'pro', subscriptionAlias: 'sub-a' }, decisionReason: 'cheapest', quotaSnapshot: { limit: 100, remaining: 40, resetAt: '2026-01-01T00:00:00Z' } };

describe('routing event schema', () => {
  it('accepts valid events for every state and rejects unknown state / missing / extra fields', () => {
    for (const state of ROUTING_STATES) expect(parseRoutingEvent({ schemaVersion: 1, timestamp: '2026-01-01T00:00:00Z', sequence: 1, attempt: 1, state }).ok).toBe(true);
    const ok = { schemaVersion: 1, timestamp: '2026-01-01T00:00:00Z', sequence: 1, attempt: 1, state: 'queued' };
    expect(parseRoutingEvent({ ...ok, state: 'bogus' }).ok).toBe(false);
    for (const k of ['timestamp', 'sequence', 'attempt', 'state']) expect(parseRoutingEvent({ ...ok, [k]: undefined }).ok).toBe(false);
    expect(parseRoutingEvent({ ...ok, prompt: 'hi' }).ok).toBe(false);
  });
  it('JSON schema file and zod agree on states and required fields', () => {
    const s = JSON.parse(readFileSync(new URL('../../../../../../schemas/routing-event.schema.json', import.meta.url), 'utf8'));
    expect(s.properties.state.enum).toEqual([...ROUTING_STATES]);
    expect(s.required).toEqual(['schemaVersion', 'timestamp', 'sequence', 'attempt', 'state']);
    expect(s.additionalProperties).toBe(false);
  });
});

describe('store', () => {
  it('assigns strictly monotonic sequence under concurrency and retries', async () => {
    const file = tmp();
    const store = new RoutingEventStore(file);
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.append(redactEvent({ ...base, attempt: (i % 3) + 1, state: i % 3 ? 'retried' : 'routed' }))));
    const seqs = new RoutingEventStore(file).read().map((e) => e.sequence);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
  it('continues sequence after reopen, tolerates torn tail, never rewrites lines', async () => {
    const file = tmp();
    const a = new RoutingEventStore(file);
    await a.append(redactEvent(base));
    const before = readFileSync(file, 'utf8');
    appendFileSync(file, '{"schemaVersion":1,"torn');
    const b = new RoutingEventStore(file);
    expect(b.read()).toHaveLength(1);
    const e = await b.append(redactEvent(base));
    expect(e.sequence).toBe(2);
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(b.read().map((x) => x.sequence)).toEqual([1, 2]);
    expect(Object.keys(b)).not.toContain('update');
  });
  it('rejects invalid events without consuming a sequence number', async () => {
    const store = new RoutingEventStore(tmp());
    await expect(store.append({ state: 'nope', attempt: 1 })).rejects.toThrow();
    expect((await store.append(redactEvent(base))).sequence).toBe(1);
  });
});

describe('redaction', () => {
  it('drops prompts/headers/unknown fields and scrubs secrets from persisted events', async () => {
    const file = tmp();
    const store = new RoutingEventStore(file);
    const dirty = { ...base, prompt: CANARIES[3], messages: [{ content: CANARIES[3] }], headers: { authorization: CANARIES[2] }, env: { API_KEY: CANARIES[0] },
      decisionReason: `used ${CANARIES[0]} and ${CANARIES[1]} with ${CANARIES[2]}`, deferralReason: 'api_key=hunter2hunter2' };
    const ev = await store.append(redactEvent(dirty));
    const text = readFileSync(file, 'utf8') + JSON.stringify(ev);
    for (const c of [...CANARIES, 'hunter2hunter2']) expect(text).not.toContain(c);
    expect(ev.selected?.subscriptionAlias).toBe('sub-a');
    expect(ev.selected?.model).toBe('gpt-x');
  });
  it('redacts structured log lines', () => {
    const lines: string[] = [];
    safeLogger((l) => lines.push(l))({ msg: `got ${CANARIES[0]}`, authorization: CANARIES[2], nested: { token: CANARIES[1], prompt: CANARIES[3] }, model: 'gpt-x' });
    for (const c of CANARIES) expect(lines.join('')).not.toContain(c);
    expect(lines[0]).toContain('gpt-x');
    expect(JSON.stringify(redactLogPayload({ password: 'x' }))).not.toContain('"x"');
  });
});

describe('emit', () => {
  it('redacts before custom sinks, supports the store as one sink, and isolates failures', async () => {
    const store = new RoutingEventStore(tmp());
    const seen: Record<string, unknown>[] = [];
    const errors: unknown[] = [];
    const reset = setRoutingEventSinks([() => { throw new Error('boom'); }, (e) => { seen.push(e); }, storeSink(store)], (e) => errors.push(e));
    try {
      await expect(emitRoutingEvent({ ...base, prompt: CANARIES[3], decisionReason: CANARIES[0] })).resolves.toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain(CANARIES[3]);
      expect(JSON.stringify(seen)).not.toContain(CANARIES[0]);
      expect(errors).toHaveLength(1);
      expect(store.read()).toHaveLength(1);
    } finally { reset(); }
  });
});
