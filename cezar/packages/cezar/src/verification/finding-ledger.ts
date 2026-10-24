import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { verificationRunSchema, type VerificationCheckRun, type VerificationRun } from '@open-mercato/cezar-contract';
import { atomicWriteJsonSync } from '../workspace/config.ts';

export const FINDING_STRATEGIES = ['parse-error', 'test-failure', 'startup-error', 'performance'] as const;
export type FindingStrategy = typeof FINDING_STRATEGIES[number];

export function strategyForVerificationCheck(checkId: string, diagnosticCode?: string): FindingStrategy {
  const hint = `${diagnosticCode ?? ''} ${checkId}`.toLowerCase();
  if (/parse|syntax|resource-import/.test(hint)) return 'parse-error';
  if (/startup|boot|launch|editor-start/.test(hint)) return 'startup-error';
  if (/perf|latency|duration|memory/.test(hint)) return 'performance';
  return 'test-failure';
}

const strategySchema = z.enum(FINDING_STRATEGIES);
const resolutionSchema = z.object({
  kind: z.enum(['human', 'verification']), actor: z.string().min(1).max(256), rationale: z.string().min(1).max(2_000),
  runId: z.string().optional(), commitSha: z.string().optional(), at: z.string().datetime(),
}).strict();
const occurrenceSchema = z.object({
  id: z.string().uuid(), findingId: z.string().uuid(), episodeId: z.string().uuid(), runId: z.string().min(1),
  verificationId: z.string().min(1), checkId: z.string().min(1), projectId: z.string().min(1),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i), environmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  strategy: strategySchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().min(1).max(128),
  message: z.string().max(2_000), file: z.string().optional(), line: z.number().int().positive().optional(),
  firstSeenAt: z.string().datetime(), observedAt: z.string().datetime(), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FindingOccurrence = z.infer<typeof occurrenceSchema>;

const episodeSchema = z.object({
  id: z.string().uuid(), number: z.number().int().positive(), openedAt: z.string().datetime(), lastSeenAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(), resolution: resolutionSchema.optional(),
}).strict();
export type FindingEpisode = z.infer<typeof episodeSchema>;

const findingSchema = z.object({
  id: z.string().uuid(), projectId: z.string().min(1), checkId: z.string().min(1), strategy: strategySchema,
  fingerprintVersion: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), aliases: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256),
  canonicalId: z.string().uuid().optional(), status: z.enum(['open', 'resolved']), createdAt: z.string().datetime(),
  firstSeenAt: z.string().datetime(), lastSeenAt: z.string().datetime(), currentEpisodeId: z.string().uuid(),
  episodes: z.array(episodeSchema).min(1).max(10_000), archivedAt: z.string().datetime().optional(),
}).strict();
export type VerificationFinding = z.infer<typeof findingSchema>;

const auditSchema = z.object({
  id: z.string().uuid(), kind: z.enum(['human-resolution', 'verification-resolution', 'reopened', 'alias-added', 'findings-merged', 'retention-archived', 'migration']),
  projectId: z.string().min(1), findingId: z.string().uuid(), relatedFindingId: z.string().uuid().optional(),
  actor: z.string().min(1).max(256), rationale: z.string().min(1).max(2_000), at: z.string().datetime(),
}).strict();
export type FindingAuditEvent = z.infer<typeof auditSchema>;

const ledgerSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1), findings: z.array(findingSchema).max(100_000),
  occurrences: z.array(occurrenceSchema).max(1_000_000), auditEvents: z.array(auditSchema).max(100_000),
  indexes: z.object({ fingerprints: z.record(z.string(), z.string().uuid()), checkIds: z.record(z.string(), z.array(z.string().uuid())) }).strict(),
}).strict();
type LedgerFile = z.infer<typeof ledgerSchema>;

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Stable v1 signatures deliberately exclude line numbers and source paths. File and line remain in evidence. */
export function findingFingerprint(input: { projectId: string; checkId: string; strategy: FindingStrategy; code: string; message: string }): string {
  const normalized = input.message
    .replace(/\bline\s+\d+\b/gi, 'line <line>')
    .replace(/:\d+(?::\d+)?\b/g, ':<line>')
    .replace(/\b0x[0-9a-f]+\b/gi, '0x<address>')
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, '<duration>ms')
    .replace(/\bpid\s*[:=]?\s*\d+\b/gi, 'pid <id>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return digest(JSON.stringify({ version: 1, projectId: input.projectId, checkId: input.checkId, strategy: input.strategy, code: input.code.toLowerCase(), message: normalized }));
}

function emptyLedger(projectId: string): LedgerFile {
  return { version: 1, projectId, findings: [], occurrences: [], auditEvents: [], indexes: { fingerprints: {}, checkIds: {} } };
}

function rebuildIndexes(state: LedgerFile): void {
  const fingerprints: Record<string, string> = {};
  const checkIds: Record<string, string[]> = {};
  for (const finding of state.findings) {
    if (finding.canonicalId) continue;
    checkIds[finding.checkId] ??= [];
    checkIds[finding.checkId]!.push(finding.id);
    for (const fingerprint of [finding.fingerprint, ...finding.aliases]) fingerprints[fingerprint] ??= finding.id;
  }
  state.indexes = { fingerprints, checkIds };
}

function migrate(raw: unknown, projectId: string, now: string): LedgerFile {
  if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 0) {
    const legacy = raw as Record<string, unknown>;
    const parsed = ledgerSchema.safeParse({ ...legacy, indexes: legacy.indexes ?? { fingerprints: {}, checkIds: {} }, version: 1 });
    if (!parsed.success) throw new Error(`finding ledger v0 migration failed: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    if (parsed.data.projectId !== projectId) throw new Error('finding ledger belongs to a different project');
    parsed.data.auditEvents.push({ id: randomUUID(), kind: 'migration', projectId, findingId: parsed.data.findings[0]?.id ?? randomUUID(), actor: 'system:migration', rationale: 'migrated ledger schema v0 to v1', at: now });
    rebuildIndexes(parsed.data);
    return parsed.data;
  }
  const parsed = ledgerSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`finding ledger is corrupt: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  if (parsed.data.projectId !== projectId) throw new Error('finding ledger belongs to a different project');
  rebuildIndexes(parsed.data);
  return parsed.data;
}

export interface FindingLedgerOptions {
  now?: () => Date;
  /** Resolved findings are archived after this many days; occurrences remain immutable. */
  retentionDays?: number;
}

/** Project-scoped recurrence ledger. All mutations reload under a cross-process lease. */
export class FindingLedger {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly retentionDays: number;

  static open(dataDir: string, projectId: string, options: FindingLedgerOptions = {}): FindingLedger {
    return new FindingLedger(dataDir, projectId, options);
  }

  private constructor(private readonly dataDir: string, readonly projectId: string, options: FindingLedgerOptions) {
    if (!projectId.trim()) throw new Error('projectId is required');
    this.filePath = join(dataDir, 'verification-findings.json');
    this.now = options.now ?? (() => new Date());
    this.retentionDays = options.retentionDays ?? 365;
  }

  async findings(): Promise<VerificationFinding[]> { return (await this.read()).findings; }
  async occurrences(findingId?: string): Promise<FindingOccurrence[]> {
    const state = await this.read();
    if (!findingId) return state.occurrences;
    const ids = new Set([findingId, ...state.findings.filter((finding) => finding.canonicalId === findingId).map((finding) => finding.id)]);
    return state.occurrences.filter((row) => ids.has(row.findingId));
  }
  async auditEvents(): Promise<FindingAuditEvent[]> { return (await this.read()).auditEvents; }

  async ingestRun(runInput: VerificationRun, strategies: Record<string, FindingStrategy>): Promise<{ recorded: number; resolved: number }> {
    const run = verificationRunSchema.parse(runInput);
    if (run.projectId !== this.projectId) throw new Error('verification run belongs to a different project');
    return this.mutate((state) => {
      let recorded = 0;
      let resolved = 0;
      const now = run.finishedAt;
      const environmentDigest = digest(JSON.stringify({ environment: run.environment, tools: run.toolVersions }));
      const errors = run.checks.filter((check) => check.status === 'failed');
      for (const check of errors) {
        const strategy = strategies[check.checkId];
        if (!strategy) continue;
        const diagnostics = check.diagnostics.filter((item) => item.severity === 'error');
        const evidence = diagnostics.length ? diagnostics : [{ code: 'check-failed', severity: 'error' as const, message: check.outputPreview.slice(0, 2_000) || `check ${check.checkId} failed` }];
        for (const diagnostic of evidence) {
          const fingerprint = findingFingerprint({ projectId: this.projectId, checkId: check.checkId, strategy, code: diagnostic.code, message: diagnostic.message });
          const indexedId = state.indexes.fingerprints[fingerprint];
          const finding = indexedId ? state.findings.find((item) => item.id === indexedId) : undefined;
          if (state.occurrences.some((occurrence) => occurrence.verificationId === run.verificationId && occurrence.checkId === check.checkId && occurrence.fingerprint === fingerprint)) continue;
          const id = finding?.id ?? randomUUID();
          let episode = finding?.episodes.find((item) => item.id === finding.currentEpisodeId);
          const reopened = Boolean(finding && finding.status === 'resolved');
          if (!finding) {
            episode = { id: randomUUID(), number: 1, openedAt: now, lastSeenAt: now };
            state.findings.push({ id, projectId: this.projectId, checkId: check.checkId, strategy, fingerprintVersion: 1, fingerprint, aliases: [], status: 'open', createdAt: now, firstSeenAt: now, lastSeenAt: now, currentEpisodeId: episode.id, episodes: [episode] });
          } else if (reopened) {
            episode = { id: randomUUID(), number: finding.episodes.length + 1, openedAt: now, lastSeenAt: now };
            finding.episodes.push(episode);
            finding.currentEpisodeId = episode.id;
            finding.status = 'open';
            finding.lastSeenAt = now;
            finding.archivedAt = undefined;
            this.addAudit(state, { kind: 'reopened', findingId: finding.id, actor: 'verification', rationale: `reproduced by run ${run.cezarRunId}`, at: now });
          } else {
            finding.lastSeenAt = now;
            if (episode) episode.lastSeenAt = now;
          }
          const active = finding ?? state.findings[state.findings.length - 1]!;
          rebuildIndexes(state);
          const activeEpisode = episode ?? active.episodes.find((item) => item.id === active.currentEpisodeId)!;
          const message = diagnostic.message.slice(0, 2_000);
          state.occurrences.push({
            id: randomUUID(), findingId: id, episodeId: activeEpisode.id, runId: run.cezarRunId, verificationId: run.verificationId,
            checkId: check.checkId, projectId: this.projectId, commitSha: run.commitSha, environmentDigest, strategy, fingerprint,
            code: diagnostic.code, message, ...(diagnostic.file ? { file: diagnostic.file } : {}), ...(diagnostic.line ? { line: diagnostic.line } : {}),
            firstSeenAt: now, observedAt: now,
            evidenceDigest: digest(JSON.stringify({ code: diagnostic.code, message, preview: check.outputPreview, rawExitCode: check.rawExitCode })),
          });
          recorded++;
        }
      }
      // A check omission, skip, no-tests, unknown or partial run is never resolution evidence.
      if (run.status === 'passed') {
        for (const check of run.checks.filter((item) => item.status === 'passed' && !item.outputTruncated && item.coverage.selected === 1 && item.coverage.passed === 1)) {
          for (const findingId of state.indexes.checkIds[check.checkId] ?? []) {
            const finding = state.findings.find((item) => item.id === findingId)!;
            if (finding.projectId !== this.projectId || finding.status !== 'open' || finding.canonicalId) continue;
            const episode = finding.episodes.find((item) => item.id === finding.currentEpisodeId);
            if (!episode) continue;
            const resolution = { kind: 'verification' as const, actor: 'verification', rationale: `relevant passing coverage from run ${run.cezarRunId}`, runId: run.cezarRunId, commitSha: run.commitSha, at: now };
            episode.resolvedAt = now;
            episode.resolution = resolution;
            finding.status = 'resolved';
            finding.lastSeenAt = now;
            this.addAudit(state, { kind: 'verification-resolution', findingId: finding.id, actor: 'verification', rationale: resolution.rationale, at: now });
            resolved++;
          }
        }
      }
      return { recorded, resolved };
    });
  }

  async resolve(findingId: string, actor: string, rationale: string): Promise<VerificationFinding> {
    return this.mutate((state) => {
      const finding = this.requireFinding(state, findingId);
      const at = this.now().toISOString();
      const episode = finding.episodes.find((item) => item.id === finding.currentEpisodeId)!;
      if (finding.status === 'open') {
        const resolution = resolutionSchema.parse({ kind: 'human', actor, rationale, at });
        episode.resolvedAt = at; episode.resolution = resolution; finding.status = 'resolved';
        this.addAudit(state, { kind: 'human-resolution', findingId, actor, rationale, at });
      }
      return finding;
    });
  }

  async addAlias(findingId: string, aliasFingerprint: string, actor: string, rationale: string): Promise<VerificationFinding> {
    if (!/^[a-f0-9]{64}$/.test(aliasFingerprint)) throw new Error('alias must be a v1 fingerprint');
    return this.mutate((state) => {
      const finding = this.requireFinding(state, findingId);
      if (!finding.aliases.includes(aliasFingerprint) && finding.fingerprint !== aliasFingerprint) finding.aliases.push(aliasFingerprint);
      this.addAudit(state, { kind: 'alias-added', findingId, actor, rationale, at: this.now().toISOString() });
      return finding;
    });
  }

  async merge(primaryId: string, duplicateId: string, actor: string, rationale: string): Promise<VerificationFinding> {
    if (primaryId === duplicateId) throw new Error('cannot merge a finding into itself');
    return this.mutate((state) => {
      const primary = this.requireFinding(state, primaryId);
      const duplicate = this.requireFinding(state, duplicateId);
      if (primary.projectId !== duplicate.projectId) throw new Error('findings from different projects cannot be merged');
      if (duplicate.canonicalId) throw new Error('finding is already merged');
      if (!primary.aliases.includes(duplicate.fingerprint)) primary.aliases.push(duplicate.fingerprint);
      for (const alias of duplicate.aliases) if (!primary.aliases.includes(alias)) primary.aliases.push(alias);
      duplicate.canonicalId = primary.id;
      if (duplicate.status === 'open') {
        const episode = duplicate.episodes.find((item) => item.id === duplicate.currentEpisodeId)!;
        const at = this.now().toISOString();
        episode.resolvedAt = at;
        episode.resolution = { kind: 'human', actor, rationale: `merged into finding ${primary.id}: ${rationale}`, at };
        duplicate.status = 'resolved';
      }
      rebuildIndexes(state);
      this.addAudit(state, { kind: 'findings-merged', findingId: primary.id, relatedFindingId: duplicate.id, actor, rationale, at: this.now().toISOString() });
      return primary;
    });
  }

  async compact(): Promise<number> {
    return this.mutate((state) => {
      const cutoff = this.now().getTime() - this.retentionDays * 86_400_000;
      let count = 0;
      for (const finding of state.findings) {
        if (finding.status !== 'resolved' || finding.archivedAt || Date.parse(finding.lastSeenAt) > cutoff) continue;
        finding.archivedAt = this.now().toISOString();
        this.addAudit(state, { kind: 'retention-archived', findingId: finding.id, actor: 'system:retention', rationale: `resolved finding archived after ${this.retentionDays} days; occurrences retained`, at: finding.archivedAt });
        count++;
      }
      rebuildIndexes(state);
      return count;
    });
  }

  private requireFinding(state: LedgerFile, id: string): VerificationFinding {
    const finding = state.findings.find((item) => item.id === id && item.projectId === this.projectId);
    if (!finding) throw new Error('finding not found in this project');
    return finding;
  }

  private addAudit(state: LedgerFile, event: Omit<FindingAuditEvent, 'id' | 'projectId'>): void {
    state.auditEvents.push(auditSchema.parse({ ...event, id: randomUUID(), projectId: this.projectId }));
  }

  private async mutate<T>(action: (state: LedgerFile) => T): Promise<T> {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.filePath, { realpath: false, stale: 10_000, update: 1_000, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
    try {
      this.ensureFile();
      const state = this.readSync();
      const result = action(state);
      rebuildIndexes(state);
      atomicWriteJsonSync(this.filePath, ledgerSchema.parse(state));
      return result;
    } finally { await release(); }
  }

  private async read(): Promise<LedgerFile> {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.filePath, { realpath: false, stale: 10_000, update: 1_000, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
    try {
      this.ensureFile();
      const state = this.readSync();
      atomicWriteJsonSync(this.filePath, state);
      return state;
    } finally { await release(); }
  }

  private readSync(): LedgerFile {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.filePath, 'utf8')); }
    catch (error) { throw new Error(`finding ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
    return migrate(raw, this.projectId, this.now().toISOString());
  }

  private ensureFile(): void {
    try { readFileSync(this.filePath); }
    catch { atomicWriteJsonSync(this.filePath, emptyLedger(this.projectId)); }
  }
}
