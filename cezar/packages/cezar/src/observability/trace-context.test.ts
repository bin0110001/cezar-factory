import { describe, expect, it } from 'vitest';
import { createChildTraceContext, createLangfuseTraceUrl, createTraceContext, parseTraceparent, safeTelemetryAttributes } from './trace-context.ts';

describe('W3C trace context', () => {
  it('creates stable trace IDs and distinct valid root span IDs', () => {
    const first = createTraceContext({ identity: 'run-17' });
    const second = createTraceContext({ identity: 'run-17' });
    expect(first.traceId).toBe(second.traceId);
    expect(first.spanId).not.toBe(second.spanId);
    expect(parseTraceparent(first.traceparent)).toMatchObject({ traceId: first.traceId, spanId: first.spanId });
  });

  it('rejects malformed, zero, and unsupported-version parents', () => {
    expect(parseTraceparent('00-00000000000000000000000000000000-1234567890abcdef-01')).toBeUndefined();
    expect(parseTraceparent('00-1234567890abcdef1234567890abcdef-0000000000000000-01')).toBeUndefined();
    expect(parseTraceparent('01-1234567890abcdef1234567890abcdef-1234567890abcdef-01')).toBeUndefined();
    expect(parseTraceparent('not-a-traceparent')).toBeUndefined();
  });

  it('keeps a valid parent trace and creates deterministic child span IDs', () => {
    const root = createTraceContext({ identity: 'run-18', spanId: '0123456789abcdef', sample: true });
    const childA = createChildTraceContext(root.traceparent, 'step:verify:1');
    const childB = createChildTraceContext(root.traceparent, 'step:verify:1');
    const other = createChildTraceContext(root.traceparent, 'step:verify:2');
    expect(childA.traceId).toBe(root.traceId);
    expect(childA.parentSpanId).toBe(root.spanId);
    expect(childA.spanId).toBe(childB.spanId);
    expect(other.spanId).not.toBe(childA.spanId);
    expect(childA.traceparent.endsWith('-01')).toBe(true);
  });

  it('inherits incoming context and sampling flags', () => {
    const parent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
    const child = createTraceContext({ identity: 'ignored-root', parentTraceparent: parent, spanId: 'fedcba0987654321' });
    expect(child).toMatchObject({ traceId: '1234567890abcdef1234567890abcdef', parentSpanId: '1234567890abcdef', traceFlags: '01' });
  });

  it('exports only bounded, allowlisted telemetry attributes', () => {
    expect(safeTelemetryAttributes({
      'workflow.step': 'validate', 'run.id': 'run-17', 'issue.number': 128, outcome: 'passed',
      prompt: 'private prompt', command: 'pwsh secret.ps1', 'error.message': 'raw output', token: 'secret',
      'model.id': 'x'.repeat(200),
    })).toEqual({
      'workflow.step': 'validate', 'run.id': 'run-17', 'issue.number': '128', outcome: 'passed', 'model.id': 'x'.repeat(128),
    });
  });

  it('builds the supported Langfuse project trace deep link and rejects unsafe inputs', () => {
    expect(createLangfuseTraceUrl({ baseUrl: 'https://langfuse.example/base/', projectId: 'factory project', traceId: 'a'.repeat(32) }))
      .toBe(`https://langfuse.example/base/project/factory%20project/traces/${'a'.repeat(32)}`);
    expect(() => createLangfuseTraceUrl({ baseUrl: 'ftp://langfuse.example', projectId: 'p', traceId: 'a'.repeat(32) })).toThrow(/HTTP\(S\)/);
    expect(() => createLangfuseTraceUrl({ baseUrl: 'https://user:password@langfuse.example', projectId: 'p', traceId: 'a'.repeat(32) })).toThrow(/credentials/);
    expect(() => createLangfuseTraceUrl({ baseUrl: 'https://langfuse.example', projectId: 'p', traceId: 'invalid' })).toThrow(/32-character/);
  });
});
