import { z } from 'zod';
import { ObligationStore, type Obligation } from './integration-obligations.ts';
import { BACKLOG_LANES, BASE_PRIORITIES } from './model.ts';
import { rankCandidates, recommend, type RankingInput } from './ranking.ts';
import { BacklogError, BacklogStore } from './store.ts';
import { buildBacklogView, type BacklogView } from './view.ts';

/**
 * HTTP-facing operations for the backlog (#194, #201), kept framework-free so they are testable
 * without a server. `server.ts` mounts them under `/backlog`.
 */
export const backlogEditSchema = z.object({
  /** Optimistic concurrency: the record revision the client last read. */
  expectedRevision: z.number().int().min(1),
  reason: z.string().max(500).optional(),
  fields: z.object({
    basePriority: z.enum(BASE_PRIORITIES), lane: z.enum(BACKLOG_LANES), backlogRank: z.string().max(64).nullable(),
    scope: z.string().max(500).nullable(), owner: z.string().max(100).nullable(), effort: z.number().int().min(0).max(1000).nullable(),
    expedite: z.boolean(), hold: z.boolean(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  }).partial().strict().default({}),
  action: z.enum(['update', 'undo']).default('update'),
});
export type BacklogEdit = z.infer<typeof backlogEditSchema>;

function rankingInputs(store: BacklogStore, repository: string): RankingInput[] {
  return store.list({ repository }).map((record) => {
    const t = store.timers(repository, record.issueNumber);
    return { record, createdAt: t.createdAt ?? record.updatedAt, expediteUntil: t.expediteUntil, snoozeUntil: t.snoozeUntil };
  });
}

export function backlogOverview(options: { store: BacklogStore; repository: string; obligations?: ObligationStore; now?: Date }): BacklogView & { conflicts: number; revisions: Record<string, number> } {
  const now = options.now ?? new Date();
  const ranked = rankCandidates(rankingInputs(options.store, options.repository), now);
  const obligations: Obligation[] = options.obligations?.queue(options.repository) ?? [];
  const audits = ranked.map((r) => ({ id: r.id, entries: options.store.audit(options.repository, r.record.issueNumber) }));
  const revisions = Object.fromEntries(ranked.map((r) => [r.id, r.record.revision]));
  return { ...buildBacklogView({ ranked, obligations, audits }), revisions, conflicts: options.store.openConflicts().filter((c) => c.key.startsWith(`${options.repository.toLowerCase()}#`)).length };
}

export function backlogRecommendation(options: { store: BacklogStore; repository: string; limit?: number; now?: Date }) {
  const now = options.now ?? new Date();
  const ranked = rankCandidates(rankingInputs(options.store, options.repository), now);
  return recommend(ranked, now, options.limit ?? 5);
}

export type EditResult = { ok: true; record: ReturnType<BacklogStore['get']> } | { ok: false; status: 404 | 409 | 422; code: string; message: string };

/** Apply a validated edit; domain errors map to stable HTTP statuses so clients can react (409 = stale, 422 = rule violation). */
export function applyBacklogEdit(store: BacklogStore, repository: string, issueNumber: number, edit: BacklogEdit, actor: string): EditResult {
  try {
    if (edit.action === 'undo') {
      return { ok: true, record: store.undoLast(repository, issueNumber, { actor, expectedRevision: edit.expectedRevision, ...(edit.reason ? { reason: edit.reason } : {}) }) };
    }
    return { ok: true, record: store.update(repository, issueNumber, edit.fields, { actor, source: 'human', expectedRevision: edit.expectedRevision, ...(edit.reason ? { reason: edit.reason } : {}) }) };
  } catch (error) {
    if (error instanceof BacklogError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'stale_revision' ? 409 : 422;
      return { ok: false, status, code: error.code, message: error.message };
    }
    throw error;
  }
}
