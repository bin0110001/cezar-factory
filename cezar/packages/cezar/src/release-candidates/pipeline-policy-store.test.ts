import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { previewPolicy, readPolicyDocument, savePolicy } from './pipeline-policy-store.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  roots.push(dir);
  return { path: join(dir, 'release', 'pipeline-policy.json'), audit: join(dir, 'release', 'pipeline-policy-audit.jsonl') };
}

const NOW = new Date('2026-11-16T12:00:00Z');
const weekly = { preset: 'weekly-calendar', triggers: { schedule: { dayOfWeek: 'thursday', hour: 3, minute: 0 } }, tests: { suites: ['unit', 'e2e'], required: ['unit', 'e2e'] } };
const daily = { preset: 'daily-calendar', triggers: { schedule: { hour: 4, minute: 30 }, afterChanges: { enabled: true, minCommits: 5 } }, tests: { suites: ['full-suite'], required: ['full-suite'] } };
const save = (p: ReturnType<typeof paths>, projectId: string, policy: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  savePolicy({ projectId, policy, reason: 'operator change', ...extra } as never, NOW, p.path, p.audit);

describe('preview', () => {
  it('shows the effective configuration, its hash and the next runs for both pilot schedules from the same editor', () => {
    const p = paths();
    const w = previewPolicy({ projectId: 'tableflux', policy: weekly }, NOW, p.path);
    const d = previewPolicy({ projectId: 'cezar-factory', policy: daily }, NOW, p.path);
    expect(w.valid && d.valid).toBe(true);
    expect(w.nextRuns).toEqual(['2026-11-19T08:00:00Z', '2026-11-26T08:00:00Z', '2026-12-03T08:00:00Z']); // Thursday 03:00 America/Detroit
    expect(d.nextRuns[0]).toBe('2026-11-17T09:30:00Z');
    expect(w.effectiveHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(w.effective).toMatchObject({ mode: 'three-branch', promotion: { stable: 'approval' } });
    expect(w.currentHash).toMatch(/^sha256:/); // nothing saved: today's configuration is the built-in two-branch default
    expect(w.currentHash).not.toBe(w.effectiveHash);
    expect(existsSync(p.path)).toBe(false); // a preview writes nothing
  });

  it('reports every error with its path and previews nothing for an invalid policy', () => {
    const r = previewPolicy({ projectId: 'p', policy: { promotion: { review: 'self-review', stable: 'auto', bogus: 1 }, tests: { suites: ['a'], required: ['b'] } } }, NOW, paths().path);
    expect(r).toMatchObject({ valid: false, effective: null, effectiveHash: null, nextRuns: [] });
    expect(r.errors.some((e) => e.startsWith('projects.p.promotion.bogus: unknown field'))).toBe(true);
  });

  it('refuses unsafe policy: more than one active candidate and unsafe auto-promotion', () => {
    const r = previewPolicy({ projectId: 'p', policy: { admission: { maxActiveCandidates: 2 } } }, NOW, paths().path);
    expect(r.errors.join(' ')).toContain('maxActiveCandidates');
    const auto = previewPolicy({ projectId: 'p', policy: { promotion: { review: 'self-review', stable: 'auto' } } }, NOW, paths().path);
    expect(auto.errors.join(' ')).toContain('unsafe auto-promotion');
  });
});

describe('save and audit', () => {
  it('writes the document and an audit entry with before and after hashes, and the change appears in the audit list', () => {
    const p = paths();
    const first = save(p, 'tableflux', weekly);
    if (!first.ok) throw new Error(first.error);
    expect(first.response).toMatchObject({ saved: true, projectId: 'tableflux', beforeHash: expect.stringMatching(/^sha256:/) as unknown as string, appliesTo: 'future-candidates' });
    expect(first.response.beforeHash).not.toBe(first.response.afterHash); // legacy default before, three-branch weekly after
    const second = save(p, 'tableflux', { ...weekly, candidateLifetimeHours: 24 });
    if (!second.ok) throw new Error(second.error);
    expect(second.response.beforeHash).toBe(first.response.afterHash);
    const doc = readPolicyDocument(p.path, p.audit);
    expect(doc.available).toBe(true);
    expect(doc.projects.tableflux!.effectiveHash).toBe(second.response.afterHash);
    expect(doc.audit.map((a) => a.id)).toEqual([second.response.auditId, first.response.auditId]); // newest first
    expect(doc.audit[0]).toMatchObject({ actor: 'local-operator', projectId: 'tableflux', beforeHash: first.response.afterHash, afterHash: second.response.afterHash, reason: 'operator change' });
    expect(JSON.parse(readFileSync(p.path, 'utf8')).schemaVersion).toBe('release-pipeline/v1'); // the document the engine reads
  });

  it('keeps projects independent in one document', () => {
    const p = paths();
    save(p, 'tableflux', weekly);
    save(p, 'cezar-factory', daily);
    const doc = readPolicyDocument(p.path, p.audit);
    expect(Object.keys(doc.projects).sort()).toEqual(['cezar-factory', 'tableflux']);
    expect(previewPolicy({ projectId: 'cezar-factory', policy: daily }, NOW, p.path).currentHash).toBe(doc.projects['cezar-factory']!.effectiveHash);
  });

  it('refuses an invalid policy without writing anything or auditing it', () => {
    const p = paths();
    const r = save(p, 'p', { admission: { maxActiveCandidates: 3 } });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(existsSync(p.path)).toBe(false);
    expect(existsSync(p.audit)).toBe(false);
  });

  it('is compare-and-swap on the effective hash, so a stale editor cannot overwrite a newer change', () => {
    const p = paths();
    const first = save(p, 'p', weekly, { expectedCurrentHash: previewPolicy({ projectId: 'p', policy: weekly }, NOW, p.path).currentHash });
    if (!first.ok) throw new Error(first.error);
    const stale = save(p, 'p', { ...weekly, candidateLifetimeHours: 12 }, { expectedCurrentHash: first.response.beforeHash });
    expect(stale).toMatchObject({ ok: false, status: 409 });
    const fresh = save(p, 'p', { ...weekly, candidateLifetimeHours: 12 }, { expectedCurrentHash: first.response.afterHash });
    expect(fresh.ok).toBe(true);
  });

  it('never shows secrets: the reason and values are redacted on write and read', () => {
    const p = paths();
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    save(p, 'p', { ...weekly, 'x-note': `contact ${token}` }, { reason: `rotated ${token}` });
    const text = JSON.stringify(readPolicyDocument(p.path, p.audit)) + readFileSync(p.audit, 'utf8') + JSON.stringify(previewPolicy({ projectId: 'p', policy: { ...weekly, 'x-note': token } }, NOW, p.path));
    expect(text).not.toContain(token);
  });

  it('an unwritable location fails closed and reports it', () => {
    const r = savePolicy({ projectId: 'p', policy: weekly, reason: 'x change' } as never, NOW, join(tmpdir(), 'nul\u0000bad', 'x.json'), join(tmpdir(), 'nul\u0000bad', 'a.jsonl'));
    expect(r).toMatchObject({ ok: false, status: 500 });
  });
});
