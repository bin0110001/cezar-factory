import { BACKLOG_LANES, BASE_PRIORITIES, EDITABLE_FIELDS, validateFields, type BacklogFields } from './model.ts';

/**
 * Authoritative editable store: a versioned machine block in the GitHub issue body. GitHub Projects
 * v2 fields are NOT the source of truth because they need a `project` token scope and GraphQL
 * access that the connector/runtime does not guarantee; the block works with plain issue write
 * access and is mirrored into the offline SQLite projection. See docs/backlog-priority.md.
 */
const BLOCK = /<!--\s*factory-backlog:v1\s+(\{[\s\S]*?\})\s*-->/;

export interface BacklogMetadata {
  fields: BacklogFields;
  /** Remote version counter bumped by every writer; the basis for stale-write detection. */
  version: number;
  /** Who last wrote the block (`cezar` marks our own echoes so sync does not loop). */
  origin: string;
  /** Nonce of the last write; with `origin` it recognises our own echoes. */
  writeId: string;
  updatedAt: string;
}

export function decodeBacklogMetadata(issueBody: string): BacklogMetadata | null {
  const match = BLOCK.exec(issueBody);
  if (!match) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(match[1]!) as Record<string, unknown>; } catch { return null; }
  const f = (raw.fields ?? {}) as Record<string, unknown>;
  const fields: BacklogFields = {
    basePriority: BASE_PRIORITIES.includes(f.basePriority as never) ? f.basePriority as BacklogFields['basePriority'] : 'unset',
    backlogRank: typeof f.backlogRank === 'string' ? f.backlogRank : null,
    lane: BACKLOG_LANES.includes(f.lane as never) ? f.lane as BacklogFields['lane'] : 'Inbox',
    scope: typeof f.scope === 'string' ? f.scope : null,
    owner: typeof f.owner === 'string' ? f.owner : null,
    effort: typeof f.effort === 'number' ? f.effort : null,
    expedite: f.expedite === true,
    hold: f.hold === true,
    dueDate: typeof f.dueDate === 'string' ? f.dueDate : null,
  };
  if (validateFields(fields).length > 0) return null;
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 0) return null;
  return {
    fields, version: raw.version,
    origin: typeof raw.origin === 'string' ? raw.origin : 'unknown',
    writeId: typeof raw.writeId === 'string' ? raw.writeId : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

export function encodeBacklogMetadata(meta: BacklogMetadata): string {
  const fields: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) fields[key] = meta.fields[key];
  return `<!-- factory-backlog:v1 ${JSON.stringify({ fields, version: meta.version, origin: meta.origin, writeId: meta.writeId, updatedAt: meta.updatedAt })} -->`;
}

/** Replace (or append) the block in an issue body, leaving all human-authored text untouched. */
export function upsertBacklogMetadata(issueBody: string, meta: BacklogMetadata): string {
  const block = encodeBacklogMetadata(meta);
  if (BLOCK.test(issueBody)) return issueBody.replace(BLOCK, () => block);
  return `${issueBody.replace(/\s+$/, '')}\n\n${block}\n`;
}
