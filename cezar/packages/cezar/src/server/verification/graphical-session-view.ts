import { redactError } from './worker-read-model.ts';

/**
 * Graphical session rows, view-only preview, takeover grants and artifact
 * browsing (#219, slice 6). Pure projections and guards: no store, scheduler,
 * display server or streaming transport (those are #108/#127/#128/#135). Media
 * is never carried here; only ids and descriptors. Missing/stale/disconnected
 * streams are never healthy.
 */

export const GRAPHICAL_VIEW_VERSION = 1;

export type StreamHealth = 'live' | 'stale' | 'unknown';

export interface GraphicalSessionRecord {
  sessionId: string;
  runId: string;
  attemptId?: string;
  scenarioId?: string;
  role?: string;
  owner?: string;
  state: 'starting' | 'running' | 'finished' | 'failed' | 'released';
  display?: string;
  renderer?: string;
  browser?: string;
  /** Abstract reserved resource labels (never host paths). */
  reservedResources?: string[];
  startedAt?: string;
  readyAt?: string;
  lastFrameAt?: string;
  workerConnected?: boolean;
}

export interface GraphicalSessionRow {
  sessionId: string;
  runId: string;
  attemptId: string | null;
  scenarioId: string | null;
  role: string | null;
  owner: string | null;
  state: GraphicalSessionRecord['state'];
  fingerprint: { display: string | null; renderer: string | null; browser: string | null };
  reservedResources: string[];
  startupMs: number | null;
  lastFrameAt: string | null;
  lastFrameAgeMs: number | null;
  stream: StreamHealth;
}

export interface GraphicalSessionPage {
  schemaVersion: typeof GRAPHICAL_VIEW_VERSION;
  rows: GraphicalSessionRow[];
}

export const DEFAULT_FRAME_STALE_MS = 10_000;

/** Strips host paths and secrets from free-form fingerprint/resource text. */
export function sanitizeLabel(raw: string | undefined): string | null {
  const s = redactError(raw);
  if (!s) return null;
  return s
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s/\\]+[/\\])+[^\s/\\]*/g, '[path]')
    .slice(0, 200);
}

export function streamHealth(rec: GraphicalSessionRecord, now: number, staleAfterMs = DEFAULT_FRAME_STALE_MS): StreamHealth {
  if (rec.state !== 'running' || rec.workerConnected === false) return rec.lastFrameAt ? 'stale' : 'unknown';
  const t = rec.lastFrameAt ? Date.parse(rec.lastFrameAt) : NaN;
  if (!Number.isFinite(t)) return 'unknown';
  const age = now - t;
  return age < 0 || age > staleAfterMs ? 'stale' : 'live';
}

export function projectGraphicalSessions(
  records: GraphicalSessionRecord[],
  now: number = Date.now(),
  staleAfterMs = DEFAULT_FRAME_STALE_MS,
): GraphicalSessionPage {
  const rows = records.map((r): GraphicalSessionRow => {
    const s = r.startedAt ? Date.parse(r.startedAt) : NaN;
    const rd = r.readyAt ? Date.parse(r.readyAt) : NaN;
    const f = r.lastFrameAt ? Date.parse(r.lastFrameAt) : NaN;
    return {
      sessionId: r.sessionId,
      runId: r.runId,
      attemptId: r.attemptId ?? null,
      scenarioId: r.scenarioId ?? null,
      role: r.role ?? null,
      owner: r.owner ?? null,
      state: r.state,
      fingerprint: { display: sanitizeLabel(r.display), renderer: sanitizeLabel(r.renderer), browser: sanitizeLabel(r.browser) },
      reservedResources: (r.reservedResources ?? []).map((x) => sanitizeLabel(x)).filter((x): x is string => !!x),
      startupMs: Number.isFinite(s) && Number.isFinite(rd) && rd >= s ? rd - s : null,
      lastFrameAt: Number.isFinite(f) ? new Date(f).toISOString() : null,
      lastFrameAgeMs: Number.isFinite(f) ? now - f : null,
      stream: streamHealth(r, now, staleAfterMs),
    };
  }).sort((a, b) => a.runId.localeCompare(b.runId) || a.sessionId.localeCompare(b.sessionId));
  return { schemaVersion: GRAPHICAL_VIEW_VERSION, rows };
}

// ---------------------------------------------------------------- preview descriptor

export const PREVIEW_LIMITS = { maxFps: 15, maxKbps: 4000, defaultFps: 5, defaultKbps: 1000 } as const;

export interface PreviewDescriptor {
  sessionId: string;
  mode: 'view-only';
  authenticated: true;
  fps: number;
  kbps: number;
  /** Streams are never healthy unless the session stream is live. */
  stream: StreamHealth;
  available: boolean;
}

export type PreviewResult =
  | { ok: true; preview: PreviewDescriptor }
  | { ok: false; code: 'unauthenticated' | 'forbidden' | 'not-found' };

function clamp(v: number | undefined, def: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return def;
  return Math.min(v, max);
}

/** Preview is opt-in, authenticated, view-only, and bounded. Takeover is never implied. */
export function describePreview(
  row: GraphicalSessionRow | undefined,
  viewer: { authenticated: boolean; permissions: string[] },
  requested: { fps?: number; kbps?: number } = {},
): PreviewResult {
  if (!viewer.authenticated) return { ok: false, code: 'unauthenticated' };
  if (!viewer.permissions.includes('preview:view')) return { ok: false, code: 'forbidden' };
  if (!row) return { ok: false, code: 'not-found' };
  return {
    ok: true,
    preview: {
      sessionId: row.sessionId,
      mode: 'view-only',
      authenticated: true,
      fps: clamp(requested.fps, PREVIEW_LIMITS.defaultFps, PREVIEW_LIMITS.maxFps),
      kbps: clamp(requested.kbps, PREVIEW_LIMITS.defaultKbps, PREVIEW_LIMITS.maxKbps),
      stream: row.stream,
      available: row.stream === 'live',
    },
  };
}

// ---------------------------------------------------------------- takeover

export type TakeoverEvent = 'request' | 'grant' | 'deny' | 'suspend' | 'release' | 'resume' | 'expire';

export interface TakeoverAudit {
  at: string;
  actor: string;
  sessionId: string;
  event: TakeoverEvent;
  reason?: string;
}

export interface TakeoverRequest {
  actor: string;
  sessionId: string;
  permissions: string[];
  /** Distinct, expiring grant; the preview permission never implies it. */
  grant?: { sessionId: string; actor: string; expiresAt: string };
}

export type TakeoverResult =
  | { ok: true; agentInput: 'suspended' }
  | { ok: false; code: 'forbidden' | 'expired' | 'busy' };

/** Takeover guard: distinct grant, agent input suspension, every transition audited (#329). */
export class TakeoverGuard {
  readonly audit: TakeoverAudit[] = [];
  private readonly active = new Map<string, string>();

  constructor(
    private readonly onAudit: (e: TakeoverAudit) => void = () => {},
    private readonly clock: () => number = Date.now,
  ) {}

  private rec(actor: string, sessionId: string, event: TakeoverEvent, reason?: string): void {
    const e: TakeoverAudit = { at: new Date(this.clock()).toISOString(), actor, sessionId, event, ...(reason ? { reason } : {}) };
    this.audit.push(e);
    this.onAudit(e);
  }

  /** Agent input is suspended while a takeover is active. */
  agentInput(sessionId: string): 'active' | 'suspended' {
    return this.active.has(sessionId) ? 'suspended' : 'active';
  }

  request(req: TakeoverRequest): TakeoverResult {
    this.rec(req.actor, req.sessionId, 'request');
    const g = req.grant;
    if (!req.permissions.includes('takeover:grant') || !g || g.sessionId !== req.sessionId || g.actor !== req.actor) {
      this.rec(req.actor, req.sessionId, 'deny', 'missing distinct takeover grant');
      return { ok: false, code: 'forbidden' };
    }
    const exp = Date.parse(g.expiresAt);
    if (!Number.isFinite(exp) || exp <= this.clock()) {
      this.rec(req.actor, req.sessionId, 'deny', 'takeover grant expired');
      return { ok: false, code: 'expired' };
    }
    if (this.active.has(req.sessionId)) {
      this.rec(req.actor, req.sessionId, 'deny', 'session already under takeover');
      return { ok: false, code: 'busy' };
    }
    this.active.set(req.sessionId, req.actor);
    this.rec(req.actor, req.sessionId, 'grant');
    this.rec(req.actor, req.sessionId, 'suspend', 'agent input suspended');
    return { ok: true, agentInput: 'suspended' };
  }

  release(actor: string, sessionId: string): boolean {
    if (this.active.get(sessionId) !== actor) return false;
    this.active.delete(sessionId);
    this.rec(actor, sessionId, 'release');
    this.rec(actor, sessionId, 'resume', 'agent input resumed');
    return true;
  }

  /** Ends takeovers whose grant has expired; input resumes. */
  expire(grants: Record<string, string>): void {
    for (const [sid, actor] of [...this.active]) {
      const exp = Date.parse(grants[sid] ?? '');
      if (!Number.isFinite(exp) || exp <= this.clock()) {
        this.active.delete(sid);
        this.rec(actor, sid, 'expire');
        this.rec(actor, sid, 'resume', 'agent input resumed');
      }
    }
  }
}

// ---------------------------------------------------------------- artifact browsing

export type BrowsableKind = 'screenshot' | 'video' | 'trace' | 'diff';

export interface BrowsableArtifact {
  id: string;
  runId: string;
  kind: BrowsableKind;
  name: string;
  permission: string;
  createdAt: string;
  /** Retention expiry; expired artifacts are not listed or downloadable. */
  expiresAt?: string;
  redacted?: boolean;
}

export interface ArtifactListing {
  items: { id: string; kind: BrowsableKind; name: string; createdAt: string }[];
  nextCursor: string | null;
  hiddenCount: number;
}

export const ARTIFACT_PAGE_MAX = 50;

export type ArtifactListResult =
  | { ok: true; page: ArtifactListing }
  | { ok: false; code: 'invalid-limit' | 'invalid-cursor' };

function visibleTo(a: BrowsableArtifact, runId: string, perms: Set<string>, now: number): 'ok' | 'hidden' | 'gone' {
  if (a.runId !== runId) return 'gone';
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) return 'gone';
  return perms.has(a.permission) ? 'ok' : 'hidden';
}

/** Cursor-paginated, permission-scoped, retention- and redaction-applied listing over the canonical artifact layer. */
export function listArtifacts(
  all: BrowsableArtifact[],
  q: { runId: string; permissions: string[]; limit?: number; cursor?: string; kind?: BrowsableKind },
  now: number = Date.now(),
): ArtifactListResult {
  const limit = q.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_PAGE_MAX) return { ok: false, code: 'invalid-limit' };
  const perms = new Set(q.permissions);
  const sorted = all
    .filter((a) => !q.kind || a.kind === q.kind)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  let hidden = 0;
  const ok: BrowsableArtifact[] = [];
  for (const a of sorted) {
    const v = visibleTo(a, q.runId, perms, now);
    if (v === 'ok') ok.push(a);
    else if (v === 'hidden') hidden++;
  }
  let start = 0;
  if (q.cursor !== undefined) {
    const idx = ok.findIndex((a) => a.id === q.cursor);
    if (idx < 0) return { ok: false, code: 'invalid-cursor' };
    start = idx + 1;
  }
  const slice = ok.slice(start, start + limit);
  const more = start + limit < ok.length;
  return {
    ok: true,
    page: {
      items: slice.map((a) => ({ id: a.id, kind: a.kind, name: sanitizeLabel(a.name) ?? '[redacted]', createdAt: a.createdAt })),
      nextCursor: more && slice.length ? slice[slice.length - 1]!.id : null,
      hiddenCount: hidden,
    },
  };
}

export type DownloadResult =
  | { ok: true; artifactId: string }
  | { ok: false; code: 'not-found' | 'forbidden' };

/** Download authorization only: returns the id to hand to the artifact layer, never bytes. */
export function authorizeDownload(
  all: BrowsableArtifact[],
  req: { runId: string; artifactId: string; permissions: string[] },
  now: number = Date.now(),
): DownloadResult {
  const a = all.find((x) => x.id === req.artifactId);
  if (!a) return { ok: false, code: 'not-found' };
  const v = visibleTo(a, req.runId, new Set(req.permissions), now);
  if (v === 'gone') return { ok: false, code: 'not-found' };
  if (v === 'hidden') return { ok: false, code: 'forbidden' };
  return { ok: true, artifactId: a.id };
}

// ---------------------------------------------------------------- multi-node checkpoints

export interface CheckpointRecord {
  node: string;
  name: string;
  at?: string;
  captured: boolean;
}

export interface CheckpointEntry {
  node: string;
  name: string;
  at: string | null;
  status: 'captured' | 'missing' | 'disconnected';
}

/** Per-node checkpoint timeline: a missing capture or disconnected node is explicit, never healthy. */
export function buildCheckpointTimeline(records: CheckpointRecord[], disconnectedNodes: string[] = []): CheckpointEntry[] {
  const down = new Set(disconnectedNodes);
  return records
    .map((r): CheckpointEntry => ({
      node: r.node,
      name: r.name,
      at: r.at ?? null,
      status: down.has(r.node) && !r.captured ? 'disconnected' : r.captured && r.at ? 'captured' : 'missing',
    }))
    .sort((a, b) => (a.at ?? '￿').localeCompare(b.at ?? '￿') || a.node.localeCompare(b.node) || a.name.localeCompare(b.name));
}
