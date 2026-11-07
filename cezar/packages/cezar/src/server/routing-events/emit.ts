import { redactEvent } from './redact.ts';
import type { RoutingEvent } from './event.ts';
import type { RoutingEventStore } from './store.ts';

/** Sink receives the already-redacted candidate event. Return the persisted event if there is one. */
export type EmitFn = (redacted: Record<string, unknown>) => Promise<RoutingEvent | void> | RoutingEvent | void;

let sinks: EmitFn[] = [];
let onError: (err: unknown) => void = () => undefined;

export function storeSink(store: RoutingEventStore): EmitFn {
  return (e) => store.append(e);
}

/** Replace the registered sinks (the default store is just one sink). Returns an unregister/reset function. */
export function setRoutingEventSinks(next: EmitFn[], errorHandler?: (err: unknown) => void): () => void {
  const prev = { sinks, onError };
  sinks = next;
  if (errorHandler) onError = errorHandler;
  return () => { sinks = prev.sinks; onError = prev.onError; };
}

/**
 * Emit a routing event from #92/#93 decision code without importing the store. The event is always
 * redacted first; sink failures are reported to the error handler and never thrown into routing.
 */
export async function emitRoutingEvent(input: unknown): Promise<void> {
  let redacted: Record<string, unknown>;
  try { redacted = redactEvent(input); } catch (err) { onError(err); return; }
  for (const sink of sinks) {
    try { await sink(redacted); } catch (err) { try { onError(err); } catch { /* never fatal */ } }
  }
}
