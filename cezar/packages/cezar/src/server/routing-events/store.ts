import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseRoutingEvent, type RoutingEvent } from './event.ts';

/**
 * Append-only JSONL routing event store (#94). Exposes append and read only: existing lines are never
 * rewritten. A single in-process serialized writer assigns the strictly monotonic sequence (recovered
 * from the file on open); a torn trailing line is tolerated on read and healed with a newline before
 * the next append. Cross-process writers are out of scope. #127 may replace this sink.
 */
export class RoutingEventStore {
  private nextSeq: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Candidate = redacted allow-listed fields; schemaVersion, sequence and (default) timestamp are set here. */
  append(candidate: Record<string, unknown>): Promise<RoutingEvent> {
    const run = this.chain.then(() => this.appendNow(candidate));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private appendNow(candidate: Record<string, unknown>): RoutingEvent {
    if (this.nextSeq === null) this.nextSeq = this.lastSequence() + 1;
    const seq = this.nextSeq;
    const parsed = parseRoutingEvent({ timestamp: new Date().toISOString(), ...candidate, schemaVersion: 1, sequence: seq });
    if (!parsed.ok) throw new Error(`invalid routing event: ${parsed.errors.join('; ')}`);
    mkdirSync(dirname(this.file), { recursive: true });
    const heal = this.needsNewline() ? '\n' : '';
    const fd = openSync(this.file, 'a', 0o600);
    try {
      writeSync(fd, `${heal}${JSON.stringify(parsed.event)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.nextSeq = seq + 1;
    return parsed.event;
  }

  private needsNewline(): boolean {
    if (!existsSync(this.file)) return false;
    const text = readFileSync(this.file, 'utf8');
    return text.length > 0 && !text.endsWith('\n');
  }

  private lastSequence(): number {
    return this.read().reduce((m, e) => Math.max(m, e.sequence), 0);
  }

  /** Read all complete, valid events in file order; torn or corrupt lines are skipped. */
  read(): RoutingEvent[] {
    if (!existsSync(this.file)) return [];
    const out: RoutingEvent[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = parseRoutingEvent(JSON.parse(line));
        if (parsed.ok) out.push(parsed.event);
      } catch { /* torn trailing line */ }
    }
    return out;
  }
}
