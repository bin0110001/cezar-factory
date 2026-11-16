import { describe, expect, it } from 'vitest';
import type { CandidateAuditEntry } from '@open-mercato/cezar-contract';
import { LifecycleRejection, runCandidateAction, type CandidateLifecyclePort } from './candidate-actions.ts';

const sha = 'a'.repeat(40);
function setup(active: { id: string; state: string } | null = null, scopes = ['*']) {
  const audit: CandidateAuditEntry[] = [];
  const calls: string[] = [];
  const lifecycle: CandidateLifecyclePort = {
    activeCandidate: async () => active,
    apply: async (_p, action, args) => { calls.push(action); if (action === 'retry' && !args.candidateId) throw new LifecycleRejection('x'); return { id: args.candidateId ?? 'c-new', state: 'pending' }; },
  };
  return { audit, calls, deps: { lifecycle, audit: { write: async (e: CandidateAuditEntry) => { audit.push(e); } }, scopes: new Set(scopes), actor: 'op' } };
}

describe('runCandidateAction', () => {
  it('refuses a second active candidate with a clear message and changes nothing', async () => {
    const s = setup({ id: 'c-1', state: 'testing' });
    const r = await runCandidateAction({ projectId: 'p', action: 'create', sourceSha: sha }, s.deps);
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('already has an active candidate (c-1');
    expect(s.calls).toEqual([]);
    expect(s.audit[0]).toMatchObject({ outcome: 'rejected', candidateId: 'c-1' });
  });
  it('denies a caller lacking the action scope and audits the denial', async () => {
    const s = setup(null, ['candidate:pause']);
    const r = await runCandidateAction({ projectId: 'p', action: 'resume', candidateId: 'c-1' }, s.deps);
    expect(r.status).toBe(403);
    expect(s.calls).toEqual([]);
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({ outcome: 'denied', action: 'resume' });
  });
  it('denies everything when no scopes are granted', async () => {
    const s = setup(null, []);
    expect((await runCandidateAction({ projectId: 'p', action: 'pause', candidateId: 'c-1' }, s.deps)).status).toBe(403);
  });
  it('requires the exact typed confirmation for cancel and abandon', async () => {
    const s = setup();
    for (const action of ['cancel', 'abandon'] as const) {
      const missing = await runCandidateAction({ projectId: 'p', action, candidateId: 'c-1' }, s.deps);
      const wrong = await runCandidateAction({ projectId: 'p', action, candidateId: 'c-1', confirmation: 'yes' }, s.deps);
      expect([missing.status, wrong.status]).toEqual([409, 409]);
      expect(missing.body.outcome).toBe('confirmation_required');
    }
    expect(s.calls).toEqual([]);
    const ok = await runCandidateAction({ projectId: 'p', action: 'cancel', candidateId: 'c-1', confirmation: 'cancel c-1' }, s.deps);
    expect(ok.status).toBe(200);
    expect(s.calls).toEqual(['cancel']);
  });
  it('delegates accepted actions and writes one redacted audit entry', async () => {
    const s = setup();
    const r = await runCandidateAction({ projectId: 'p', action: 'create', sourceSha: sha }, s.deps);
    expect(r.body).toMatchObject({ outcome: 'accepted', candidateId: 'c-new' });
    expect(s.audit).toHaveLength(1);
    expect(Object.keys(s.audit[0]!).sort()).toEqual(['action', 'actor', 'at', 'candidateId', 'outcome', 'projectId']);
    expect(JSON.stringify(s.audit)).not.toContain(sha);
  });
  it('maps lifecycle refusals to a rejected outcome', async () => {
    const s = setup();
    const r = await runCandidateAction({ projectId: 'p', action: 'retry' }, s.deps);
    expect(r.status).toBe(400);
  });
});
