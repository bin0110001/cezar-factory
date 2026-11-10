import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import {
  verificationFindingKindSchema,
  type VerificationCheckRun,
  type VerificationRun,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';

export const FINDING_LEDGER_SCHEMA_VERSION = 1;
export const DEFAULT_FINDING_LEDGER_RETENTION_DAYS = 180;
const LOCK = 'verification-ledger.lock';
const DAY_MS = 24 * 60 * 60 * 1_000;

const idSchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime();
const projectIdSchema = z.string().min(1).max(256);
const findingSchema = z.object({
  id: idSchema,
  projectId: projectIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  kind: verificationFindingKindSchema,
  strategyId: z.string().min(1).max(128),
  strategyVersion: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
}).strict();
const diagnosticSchema = z.object({
  code: z.string().min(1).max(128),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().max(2_000),
  file: z.string().max(1_024).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
}).strict();
const occurrenceSchema = z.object({
  id: idSchema,
  projectId: projectIdSchema,
  findingId: idSchema,
  verificationId: idSchema,
  runId: idSchema,
  attempt: z.number().int().positive(),
  checkId: idSchema,
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  environment: z.record(z.string(), z.string().max(256)),
  diagnostics: z.array(diagnosticSchema).max(200),
  evidenceRefs: z.array(idSchema).max(100),
  observedAt: timestampSchema,
  /** Each immutable occurrence is one observation; first and last are equal by definition. */
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
}).strict().superRefine((occurrence, ctx) => {
  if (occurrence.firstSeenAt !== occurrence.observedAt || occurrence.lastSeenAt !== occurrence.observedAt) {
    ctx.addIssue({ code: 'custom', path: ['observedAt'], message: 'an immutable occurrence records one observation time' });
  }
});
const episodeSchema = z.object({
  id: idSchema,
  projectId: projectIdSchema,
  findingId: idSchema,
  status: z.enum(['open', 'resolved']),
  occurrenceIds: z.array(idSchema).max(100_000),
  openedAt: timestampSchema,
  lastSeenAt: timestampSchema,
  resolvedAt: timestampSchema.optional(),
}).strict().superRefine((episode, ctx) => {
  if (episode.status === 'open' && episode.resolvedAt) ctx.addIssue({ code: 'custom', path: ['resolvedAt'], message: 'open episodes cannot have a resolution time' });
  if (episode.status === 'resolved' && !episode.resolvedAt) ctx.addIssue({ code: 'custom', path: ['resolvedAt'], message: 'resolved episodes require a resolution time' });
});
const aliasSchema = z.object({
  id: idSchema,
  projectId: projectIdSchema,
  sourceFindingId: idSchema,
  targetFindingId: idSchema,
  action: z.enum(['alias', 'merge']),
  reason: z.string().min(1).max(2_000),
  actor: z.string().min(1).max(256),
  createdAt: timestampSchema,
}).strict().refine((alias) => alias.sourceFindingId !== alias.targetFindingId, 'a finding cannot alias itself');

const ledgerFileSchema = z.object({
  schemaVersion: z.literal(FINDING_LEDGER_SCHEMA_VERSION),
  projectId: projectIdSchema,
  findings: z.array(findingSchema).max(1_000_000),
  occurrences: z.array(occurrenceSchema).max(1_000_000),
  episodes: z.array(episodeSchema).max(1_000_000),
  aliases: z.array(aliasSchema).max(1_000_000),
}).strict().superRefine((ledger, ctx) => {
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  for (const [kind, records] of Object.entries({
    findings: ledger.findings,
    occurrences: ledger.occurrences,
    episodes: ledger.episodes,
    aliases: ledger.aliases,
  })) {
    for (const [index, record] of records.entries()) {
      if (record.projectId !== ledger.projectId) ctx.addIssue({ code: 'custom', path: [kind, index, 'projectId'], message: 'record project id must match its ledger' });
      if (ids.has(record.id)) ctx.addIssue({ code: 'custom', path: [kind, index, 'id'], message: 'record ids must be unique within a project ledger' });
      ids.add(record.id);
    }
  }
  for (const [index, finding] of ledger.findings.entries()) {
    if (fingerprints.has(finding.fingerprint)) ctx.addIssue({ code: 'custom', path: ['findings', index, 'fingerprint'], message: 'finding fingerprints must be unique within a project ledger' });
    fingerprints.add(finding.fingerprint);
  }
  const findings = new Map(ledger.findings.map((finding) => [finding.id, finding]));
  const occurrences = new Map(ledger.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  for (const [index, occurrence] of ledger.occurrences.entries()) {
    if (!findings.has(occurrence.findingId)) ctx.addIssue({ code: 'custom', path: ['occurrences', index, 'findingId'], message: 'occurrence must reference a finding in this project ledger' });
  }
  for (const [index, episode] of ledger.episodes.entries()) {
    if (!findings.has(episode.findingId)) ctx.addIssue({ code: 'custom', path: ['episodes', index, 'findingId'], message: 'episode must reference a finding in this project ledger' });
    for (const occurrenceId of episode.occurrenceIds) {
      const occurrence = occurrences.get(occurrenceId);
      if (!occurrence || occurrence.findingId !== episode.findingId) ctx.addIssue({ code: 'custom', path: ['episodes', index, 'occurrenceIds'], message: 'episode occurrences must belong to its finding' });
    }
  }
  for (const [index, alias] of ledger.aliases.entries()) {
    if (!findings.has(alias.sourceFindingId) || !findings.has(alias.targetFindingId)) ctx.addIssue({ code: 'custom', path: ['aliases', index], message: 'alias findings must belong to this project ledger' });
  }
});
type LedgerFile = z.infer<typeof ledgerFileSchema>;
export type FindingRecord = z.infer<typeof findingSchema>;
export type OccurrenceRecord = z.infer<typeof occurrenceSchema>;
export type EpisodeRecord = z.infer<typeof episodeSchema>;
export type FindingAliasRecord = z.infer<typeof aliasSchema>;

export interface FindingLedgerOptions {
  now?: () => Date;
  /** Keep observations newer than this many days. Resolved episodes age out on the same cutoff. */
  retentionDays?: number;
}

export interface CreateFindingInput {
  fingerprint: string;
  kind: FindingRecord['kind'];
  strategyId: string;
  strategyVersion: number;
  at?: string;
}

export interface AppendOccurrenceInput {
  /** Set when adapting a contract result; the store verifies it matches its project. */
  projectId?: string;
  findingId: string;
  verificationId: string;
  runId: string;
  attempt: number;
  checkId: string;
  commitSha: string;
  environment: Record<string, string>;
  diagnostics: VerificationCheckRun['diagnostics'];
  evidenceRefs?: string[];
  observedAt?: string;
  id?: string;
}

export interface CreateEpisodeInput {
  findingId: string;
  occurrenceIds: string[];
  openedAt: string;
  id?: string;
}

export interface AppendFindingAliasInput {
  sourceFindingId: string;
  targetFindingId: string;
  action: FindingAliasRecord['action'];
  reason: string;
  actor: string;
  createdAt?: string;
  id?: string;
}

export interface FindingLedgerSnapshot {
  schemaVersion: typeof FINDING_LEDGER_SCHEMA_VERSION;
  projectId: string;
  findings: FindingRecord[];
  occurrences: OccurrenceRecord[];
  episodes: EpisodeRecord[];
  aliases: FindingAliasRecord[];
}

/**
 * Project-scoped persistence boundary for the verification finding ledger.
 * Records are written atomically under a cross-process lock. Occurrences and
 * alias decisions are append-only; finding summaries and episode state are
 * updated through narrow methods. Indexes are rebuilt from validated records
 * at open/read time instead of being trusted as persisted authority.
 */
export interface FindingLedgerStore {
  readonly projectId: string;
  snapshot(): FindingLedgerSnapshot;
  getFindingByFingerprint(fingerprint: string): FindingRecord | undefined;
  occurrencesForFinding(findingId: string): OccurrenceRecord[];
  episodesForFinding(findingId: string): EpisodeRecord[];
  aliasesForFinding(findingId: string): FindingAliasRecord[];
  createFinding(input: CreateFindingInput): FindingRecord;
  appendOccurrence(input: AppendOccurrenceInput): OccurrenceRecord;
  createEpisode(input: CreateEpisodeInput): EpisodeRecord;
  appendOccurrenceToEpisode(episodeId: string, occurrenceId: string): EpisodeRecord;
  resolveEpisode(episodeId: string, resolvedAt: string): EpisodeRecord;
  appendAlias(input: AppendFindingAliasInput): FindingAliasRecord;
  prune(): { occurrences: number; episodes: number };
}

/** Build a storage input from the contract-owned result and check records. */
export function occurrenceFromVerification(
  run: VerificationRun,
  check: VerificationCheckRun,
  findingId: string,
  evidenceRefs: string[] = [],
): AppendOccurrenceInput {
  return {
    projectId: run.projectId,
    findingId,
    verificationId: run.verificationId,
    runId: run.cezarRunId,
    attempt: check.attempt,
    checkId: check.checkId,
    commitSha: run.commitSha,
    environment: run.environment,
    diagnostics: check.diagnostics,
    evidenceRefs,
    observedAt: run.finishedAt,
  };
}

export class FileFindingLedgerStore implements FindingLedgerStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private data: LedgerFile;
  private findingsByFingerprint = new Map<string, FindingRecord>();
  private occurrencesByFinding = new Map<string, OccurrenceRecord[]>();
  private episodesByFinding = new Map<string, EpisodeRecord[]>();
  private aliasesByFinding = new Map<string, FindingAliasRecord[]>();

  static open(dataDir: string, projectId: string, options: FindingLedgerOptions = {}): FileFindingLedgerStore {
    return new FileFindingLedgerStore(dataDir, projectId, options);
  }

  private constructor(readonly dataDir: string, readonly projectId: string, options: FindingLedgerOptions) {
    projectIdSchema.parse(projectId);
    const retentionDays = options.retentionDays ?? DEFAULT_FINDING_LEDGER_RETENTION_DAYS;
    if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error('finding ledger retentionDays must be at least 1');
    this.now = options.now ?? (() => new Date());
    this.retentionMs = retentionDays * DAY_MS;
    this.filePath = join(dataDir, 'verification-ledger.json');
    this.lockPath = join(dataDir, LOCK);
    this.data = this.withLock(() => {
      const loaded = this.readFromDisk();
      const pruned = this.applyRetention(loaded.data);
      if (pruned.changed || loaded.migrated) this.writeFile(pruned.data);
      return pruned.data;
    });
    this.rebuildIndexes();
  }

  snapshot(): FindingLedgerSnapshot {
    this.refresh();
    return clone(this.data);
  }

  getFindingByFingerprint(fingerprint: string): FindingRecord | undefined {
    this.refresh();
    const record = this.findingsByFingerprint.get(`${this.projectId}\0${fingerprint}`);
    return record && clone(record);
  }

  occurrencesForFinding(findingId: string): OccurrenceRecord[] {
    this.refresh();
    return clone(this.occurrencesByFinding.get(this.indexKey(findingId)) ?? []);
  }

  episodesForFinding(findingId: string): EpisodeRecord[] {
    this.refresh();
    return clone(this.episodesByFinding.get(this.indexKey(findingId)) ?? []);
  }

  aliasesForFinding(findingId: string): FindingAliasRecord[] {
    this.refresh();
    return clone(this.aliasesByFinding.get(this.indexKey(findingId)) ?? []);
  }

  createFinding(input: CreateFindingInput): FindingRecord {
    const at = input.at ?? this.now().toISOString();
    const parsed = findingSchema.parse({
      id: randomUUID(), projectId: this.projectId, fingerprint: input.fingerprint, kind: input.kind,
      strategyId: input.strategyId, strategyVersion: input.strategyVersion,
      createdAt: at, updatedAt: at, firstSeenAt: at, lastSeenAt: at,
    });
    return this.mutate((data) => {
      const existing = data.findings.find((finding) => finding.fingerprint === parsed.fingerprint);
      if (existing) {
        if (existing.strategyId !== parsed.strategyId || existing.strategyVersion !== parsed.strategyVersion || existing.kind !== parsed.kind) {
          throw new Error('finding fingerprint already exists with different strategy metadata');
        }
        return existing;
      }
      data.findings.push(parsed);
      return parsed;
    });
  }

  appendOccurrence(input: AppendOccurrenceInput): OccurrenceRecord {
    if (input.projectId !== undefined && input.projectId !== this.projectId) throw new Error('verification result project id does not match the ledger project');
    const observedAt = input.observedAt ?? this.now().toISOString();
    const secrets = collectSecretValues();
    const parsed = occurrenceSchema.parse({
      ...input,
      id: input.id ?? randomUUID(),
      projectId: this.projectId,
      environment: redactDeep(input.environment, secrets),
      diagnostics: redactDeep(input.diagnostics, secrets),
      evidenceRefs: input.evidenceRefs ?? [],
      observedAt,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    });
    return this.mutate((data) => {
      const finding = data.findings.find((record) => record.id === parsed.findingId);
      if (!finding) throw new Error(`unknown finding ${parsed.findingId}`);
      const existing = data.occurrences.find((record) => record.id === parsed.id);
      if (existing) throw new Error(`occurrence id already exists: ${parsed.id}`);
      data.occurrences.push(parsed);
      finding.lastSeenAt = latest(finding.lastSeenAt, observedAt);
      finding.updatedAt = latest(finding.updatedAt, observedAt);
      return parsed;
    });
  }

  createEpisode(input: CreateEpisodeInput): EpisodeRecord {
    const parsed = episodeSchema.parse({
      id: input.id ?? randomUUID(), projectId: this.projectId, findingId: input.findingId,
      status: 'open', occurrenceIds: input.occurrenceIds, openedAt: input.openedAt,
      lastSeenAt: input.openedAt,
    });
    return this.mutate((data) => {
      if (!data.findings.some((finding) => finding.id === parsed.findingId)) throw new Error(`unknown finding ${parsed.findingId}`);
      const occurrenceIds = new Set(data.occurrences.map((occurrence) => occurrence.id));
      if (parsed.occurrenceIds.some((id) => !occurrenceIds.has(id))) throw new Error('episode references an unknown occurrence');
      if (data.episodes.some((episode) => episode.id === parsed.id)) throw new Error(`episode id already exists: ${parsed.id}`);
      data.episodes.push(parsed);
      return parsed;
    });
  }

  appendOccurrenceToEpisode(episodeId: string, occurrenceId: string): EpisodeRecord {
    return this.mutate((data) => {
      const episode = data.episodes.find((record) => record.id === episodeId);
      if (!episode) throw new Error(`unknown episode ${episodeId}`);
      if (episode.status !== 'open') throw new Error('resolved episodes are immutable; create a new episode');
      const occurrence = data.occurrences.find((record) => record.id === occurrenceId);
      if (!occurrence) throw new Error(`unknown occurrence ${occurrenceId}`);
      if (occurrence.findingId !== episode.findingId) throw new Error('episode occurrence belongs to a different finding');
      if (!episode.occurrenceIds.includes(occurrenceId)) episode.occurrenceIds.push(occurrenceId);
      episode.lastSeenAt = latest(episode.lastSeenAt, occurrence.observedAt);
      return episode;
    });
  }

  resolveEpisode(episodeId: string, resolvedAt: string): EpisodeRecord {
    timestampSchema.parse(resolvedAt);
    return this.mutate((data) => {
      const episode = data.episodes.find((record) => record.id === episodeId);
      if (!episode) throw new Error(`unknown episode ${episodeId}`);
      if (episode.status === 'resolved') {
        if (episode.resolvedAt !== resolvedAt) throw new Error('resolved episodes are immutable');
        return episode;
      }
      episode.status = 'resolved';
      episode.resolvedAt = resolvedAt;
      return episode;
    });
  }

  appendAlias(input: AppendFindingAliasInput): FindingAliasRecord {
    const secrets = collectSecretValues();
    const parsed = aliasSchema.parse({
      ...input, reason: redactDeep(input.reason, secrets), id: input.id ?? randomUUID(), projectId: this.projectId,
      createdAt: input.createdAt ?? this.now().toISOString(),
    });
    return this.mutate((data) => {
      const ids = new Set(data.findings.map((finding) => finding.id));
      if (!ids.has(parsed.sourceFindingId) || !ids.has(parsed.targetFindingId)) throw new Error('alias references an unknown finding');
      if (data.aliases.some((alias) => alias.id === parsed.id)) throw new Error(`alias id already exists: ${parsed.id}`);
      data.aliases.push(parsed);
      return parsed;
    });
  }

  prune(): { occurrences: number; episodes: number } {
    return this.withLock(() => {
      const loaded = this.readFromDisk();
      const result = this.applyRetention(loaded.data);
      if (result.changed || loaded.migrated) this.writeFile(result.data);
      this.data = result.data;
      this.rebuildIndexes();
      return { occurrences: result.removedOccurrences, episodes: result.removedEpisodes };
    });
  }

  private refresh(): void {
    this.data = this.withLock(() => {
      const loaded = this.readFromDisk();
      const result = this.applyRetention(loaded.data);
      if (result.changed || loaded.migrated) this.writeFile(result.data);
      return result.data;
    });
    this.rebuildIndexes();
  }

  private mutate<T>(operation: (data: LedgerFile) => T): T {
    return this.withLock(() => {
      const loaded = this.readFromDisk();
      const retained = this.applyRetention(loaded.data);
      const result = operation(retained.data);
      const validated = ledgerFileSchema.parse(retained.data);
      this.writeFile(validated);
      this.data = validated;
      this.rebuildIndexes();
      return clone(result);
    });
  }

  private withLock<T>(fn: () => T): T {
    mkdirSync(this.dataDir, { recursive: true });
    const fd = openSync(this.lockPath, 'a', 0o600);
    closeSync(fd);
    const release = lockfile.lockSync(this.lockPath, { realpath: false, retries: 0 });
    try { return fn(); } finally { release(); }
  }

  private readFromDisk(): { data: LedgerFile; migrated: boolean } {
    if (!existsSync(this.filePath)) return { data: emptyLedger(this.projectId), migrated: false };
    const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
    const migrated = migrateLedger(raw, this.projectId);
    return { data: ledgerFileSchema.parse(migrated.data), migrated: migrated.changed };
  }

  private writeFile(data: LedgerFile): void {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(ledgerFileSchema.parse(data), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* no temporary file */ }
      throw error;
    }
  }

  private applyRetention(data: LedgerFile): { data: LedgerFile; changed: boolean; removedOccurrences: number; removedEpisodes: number } {
    const cutoff = this.now().getTime() - this.retentionMs;
    const keep = (timestamp: string) => Date.parse(timestamp) >= cutoff;
    const beforeOccurrences = data.occurrences.length;
    const keptOccurrences = data.occurrences.filter((occurrence) => keep(occurrence.observedAt));
    const occurrenceIds = new Set(keptOccurrences.map((occurrence) => occurrence.id));
    const beforeEpisodes = data.episodes.length;
    data.episodes = data.episodes.flatMap((episode) => {
      if (episode.status === 'resolved' && episode.resolvedAt && !keep(episode.resolvedAt)) return [];
      episode.occurrenceIds = episode.occurrenceIds.filter((id) => occurrenceIds.has(id));
      return [episode];
    });
    data.occurrences = keptOccurrences;
    const removedOccurrences = beforeOccurrences - keptOccurrences.length;
    const removedEpisodes = beforeEpisodes - data.episodes.length;
    return { data, changed: removedOccurrences > 0 || removedEpisodes > 0, removedOccurrences, removedEpisodes };
  }

  private rebuildIndexes(): void {
    this.findingsByFingerprint = new Map(this.data.findings.map((finding) => [`${finding.projectId}\0${finding.fingerprint}`, finding]));
    this.occurrencesByFinding = groupBy(this.data.occurrences, (record) => this.indexKey(record.findingId));
    this.episodesByFinding = groupBy(this.data.episodes, (record) => this.indexKey(record.findingId));
    this.aliasesByFinding = groupBy(this.data.aliases, (record) => this.indexKey(record.sourceFindingId));
  }

  private indexKey(id: string): string { return `${this.projectId}\0${id}`; }
}

function emptyLedger(projectId: string): LedgerFile {
  return { schemaVersion: FINDING_LEDGER_SCHEMA_VERSION, projectId, findings: [], occurrences: [], episodes: [], aliases: [] };
}

function latest(a: string, b: string): string { return Date.parse(a) >= Date.parse(b) ? a : b; }

function groupBy<T>(records: T[], key: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const id = key(record);
    const list = grouped.get(id) ?? [];
    list.push(record);
    grouped.set(id, list);
  }
  return grouped;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** v0 omitted record-level project keys and stored one timestamp per observation. */
function migrateLedger(raw: unknown, projectId: string): { data: unknown; changed: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid finding ledger file');
  const value = raw as Record<string, unknown>;
  const version = value.schemaVersion ?? 0;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new Error('invalid finding ledger schema version');
  if (version > FINDING_LEDGER_SCHEMA_VERSION) throw new Error(`finding ledger schema version ${version} is newer than supported`);
  if (version === FINDING_LEDGER_SCHEMA_VERSION) {
    if (value.projectId !== projectId) throw new Error('finding ledger project id does not match the requested project');
    return { data: value, changed: false };
  }
  const legacyProjectId = value.projectId;
  if (legacyProjectId !== undefined && legacyProjectId !== projectId) throw new Error('legacy finding ledger project id does not match the requested project');
  const rows = (key: string): Record<string, unknown>[] => {
    const row = value[key];
    if (row === undefined) return [];
    if (!Array.isArray(row) || row.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error(`invalid legacy finding ledger ${key}`);
    return row as Record<string, unknown>[];
  };
  const findings = rows('findings').map((item) => ({ ...item, projectId }));
  const occurrences = rows('occurrences').map((item) => ({
    ...item,
    projectId,
    firstSeenAt: item.firstSeenAt ?? item.observedAt,
    lastSeenAt: item.lastSeenAt ?? item.observedAt,
  }));
  const episodes = rows('episodes').map((item) => ({ ...item, projectId }));
  const aliases = rows('aliases').map((item) => ({ ...item, projectId }));
  return { data: { schemaVersion: FINDING_LEDGER_SCHEMA_VERSION, projectId, findings, occurrences, episodes, aliases }, changed: true };
}
