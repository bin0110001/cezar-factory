import { afterEach, describe, expect, it } from 'vitest';
import { backlogAdmitFragment, backlogSchedulingMode, createBacklogAdmission } from './admission-hook.ts';
import { BacklogStore } from './store.ts';

const stores: BacklogStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
const store = () => { const s = new BacklogStore({ path: ':memory:' }); stores.push(s); return s; };
const cand = (n: number, labels: string[]) => ({ number: n, labels, timestamp: '2026-11-01T00:00:00Z' });

describe('backlog admission hook', () => {
  it('is off unless explicitly enabled', () => {
    expect(backlogSchedulingMode({})).toBe('off');
    expect(backlogSchedulingMode({ CEZAR_BACKLOG_SCHEDULING: 'bogus' })).toBe('off');
    expect(backlogSchedulingMode({ CEZAR_BACKLOG_SCHEDULING: 'Shadow' })).toBe('shadow');
    expect(backlogAdmitFragment('o', 'r', undefined, {})).toEqual({});
    expect(backlogAdmitFragment('o', 'r', undefined, { CEZAR_BACKLOG_SCHEDULING: 'shadow' }).backlogAdmit).toBeTypeOf('function');
  });
  it('shadow mode records the would-be deferral but never blocks', async () => {
    const decisions: string[] = [];
    const hook = createBacklogAdmission({ repository: 'o/r', store: store(), mode: 'shadow', onDecision: (d) => decisions.push(`${d.kind}:${d.reason}`) });
    const result = await hook(cand(1, ['P0', 'factory:needs-plan']));
    expect(result).toMatchObject({ allow: true, shadow: true });
    expect(decisions).toEqual(['DEFER:not-ready']);
  });
  it('enforce mode defers non-Ready work and admits Ready work, honouring later human edits', async () => {
    const s = store();
    const hook = createBacklogAdmission({ repository: 'o/r', store: s, mode: 'enforce', config: { reservedHighPrioritySlots: 0 } });
    expect(await hook(cand(1, ['P0', 'factory:needs-plan']))).toMatchObject({ allow: false, shadow: false });
    expect(await hook(cand(2, ['P2', 'factory:ready']))).toMatchObject({ allow: true });
    s.update('o/r', 2, { hold: true }, { actor: 'alice' });
    const held = await hook(cand(2, ['P2', 'factory:ready']));
    expect(held.allow).toBe(false);
    expect(held.decision.reason).toBe('on-hold');
  });
  it('defers on running file conflicts using supplied running work', async () => {
    const hook = createBacklogAdmission({
      repository: 'o/r', store: store(), mode: 'enforce', config: { reservedHighPrioritySlots: 0 },
      running: () => [{ id: 'o/r#9', repository: 'o/r' }],
    });
    const r = await hook(cand(3, ['P1', 'factory:ready']));
    expect(r).toMatchObject({ allow: false });
    expect(r.decision.reason).toBe('conflict-unknown'); // no manifests: unknown, not safe
  });
});
