import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  canonicalizeFactoryJson,
  factoryDeploymentReceiptSchema,
  factoryReleaseChannelPointerSchema,
  parseFactoryReleaseManifest,
  parseFactoryReleaseState,
  type FactoryChannel,
} from '@open-mercato/cezar-contract';

const ACTIVE_TASK_STATES = new Set(['queued', 'running', 'waiting']);
const SUCCESS_RECEIPT_STATES = new Set(['active', 'healthy']);

export interface ProjectChannelTask {
  id: string;
  title: string;
  status: string;
  channel?: FactoryChannel;
  sourceSha?: string;
}

export interface ProjectChannelContext {
  storeRoot?: string;
  projectRoot: string;
  projectId: string;
  configuredChannel?: FactoryChannel;
  effectiveSha?: string;
  compatibility: 'compatible' | 'incompatible' | 'unknown';
  activeTasks: ProjectChannelTask[];
}

export interface ChannelTarget {
  sourceSha: string;
  runtimeRoot: string;
}

async function jsonFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch { return undefined; }
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function safeManagedPath(root: string, value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
  const target = resolve(root, ...normalized.split('/'));
  const rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return target;
}

async function overrideDiff(projectRoot: string, targetRoot: string): Promise<Array<{ path: string; status: 'unmodified' | 'preserved' | 'override-only' | 'conflict' }>> {
  const managedRoot = join(projectRoot, '.ai', 'factory');
  const manifest = await jsonFile(join(managedRoot, 'manifest.json')) as { files?: unknown } | undefined;
  if (!manifest || !Array.isArray(manifest.files)) return [];
  const results: Array<{ path: string; status: 'unmodified' | 'preserved' | 'override-only' | 'conflict' }> = [];
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object') continue;
    const entry = file as { path?: unknown; sha256?: unknown };
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') continue;
    const projectPath = safeManagedPath(managedRoot, entry.path);
    const relativePath = entry.path.replaceAll('\\', '/');
    const releasePath = safeManagedPath(targetRoot, relativePath);
    if (!projectPath || !releasePath) continue;
    const [installedBytes, targetBytes] = await Promise.all([
      readFile(projectPath).catch(() => undefined), readFile(releasePath).catch(() => undefined),
    ]);
    const installedDigest = installedBytes && sha256(installedBytes);
    if (installedDigest === entry.sha256) {
      results.push({ path: relativePath, status: 'unmodified' });
    } else if (!targetBytes) {
      results.push({ path: relativePath, status: 'override-only' });
    } else if (sha256(targetBytes) !== entry.sha256) {
      results.push({ path: relativePath, status: 'conflict' });
    } else {
      results.push({ path: relativePath, status: 'preserved' });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export class ProjectChannelService {
  constructor(private readonly context: ProjectChannelContext, private readonly now = () => new Date().toISOString()) {}

  private async pointer(channel: FactoryChannel) {
    if (!this.context.storeRoot) return undefined;
    const raw = await jsonFile(join(this.context.storeRoot, 'channels', `${channel}.json`));
    const parsed = factoryReleaseChannelPointerSchema.safeParse(raw);
    return parsed.success && parsed.data.channel === channel ? parsed.data : undefined;
  }

  private async receipts() {
    if (!this.context.storeRoot) return [];
    const base = join(this.context.storeRoot, 'receipts', sha256(this.context.projectId).slice(0, 24));
    const records: Array<ReturnType<typeof factoryDeploymentReceiptSchema.parse>> = [];
    let generations: string[];
    try { generations = await readdir(base); } catch { return records; }
    for (const generation of generations) {
      let entries: string[];
      try { entries = await readdir(join(base, generation)); } catch { continue; }
      for (const filename of entries.filter((name) => name.endsWith('.json'))) {
        const raw = await jsonFile(join(base, generation, filename));
        const parsed = factoryDeploymentReceiptSchema.safeParse(raw);
        if (parsed.success && parsed.data.targetId === this.context.projectId) records.push(parsed.data);
      }
    }
    return records.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.activationGeneration - b.activationGeneration);
  }

  async controlCenter() {
    const [state, receipts, devPointer, stablePointer] = await Promise.all([
      this.state(), this.receipts(), this.pointer('dev'), this.pointer('stable'),
    ]);
    const history = receipts.slice(-20).reverse().map((receipt) => ({
      id: receipt.receiptId,
      channel: receipt.channel,
      desiredSha: receipt.desiredSha,
      actualSha: receipt.actualSha,
      observedSha: receipt.observedSha,
      state: receipt.state,
      requestedAt: receipt.requestedAt,
      stagedAt: receipt.stagedAt ?? null,
      activatedAt: receipt.activatedAt ?? null,
      observedAt: receipt.observedAt ?? null,
      compatibility: receipt.compatibility?.status ?? 'unknown',
      reasonCode: receipt.reasonCode ?? null,
      message: receipt.message ?? null,
      logRef: receipt.logRef ?? null,
    }));
    const channels = await Promise.all(([
      ['dev', devPointer], ['stable', stablePointer],
    ] as const).map(async ([channel, pointer]) => {
      const latest = [...receipts].reverse().find((receipt) => receipt.channel === channel);
      const quarantined = Boolean(pointer && this.context.storeRoot && await jsonFile(join(this.context.storeRoot, 'quarantine', `${pointer.currentSha}.json`)));
      const releaseRoot = pointer && this.context.storeRoot ? join(this.context.storeRoot, 'releases', pointer.currentSha) : undefined;
      const manifest = releaseRoot ? parseFactoryReleaseManifest(await jsonFile(join(releaseRoot, 'manifest.json'))) : undefined;
      const release = releaseRoot ? parseFactoryReleaseState(await jsonFile(join(releaseRoot, 'state.json'))) : undefined;
      const state = !pointer ? 'unknown'
        : quarantined ? 'quarantined'
          : latest && ['pending', 'staged', 'activating'].includes(latest.state) && latest.desiredSha === pointer.currentSha ? 'activating'
            : latest?.state === 'active' && latest.desiredSha === pointer.currentSha && latest.actualSha === pointer.currentSha && latest.observedSha === pointer.currentSha ? 'healthy'
              : release?.status === 'valid' && release.data.state === 'quarantined' ? 'quarantined'
                : release?.status === 'valid' && release.data.state === 'verified' ? 'eligible'
                  : release?.status === 'valid' && release.data.state === 'built' ? 'candidate'
                    : 'unknown';
      return {
        channel,
        desiredSha: pointer?.currentSha ?? null,
        activatedSha: latest?.desiredSha ?? null,
        observedSha: latest?.observedSha ?? null,
        state,
        updatedAt: pointer?.updatedAt ?? null,
        manifestDigest: manifest?.status === 'valid' && manifest.data.source.sha === pointer?.currentSha ? manifest.data.manifestDigest : null,
        manifest: manifest?.status === 'valid' && manifest.data.source.sha === pointer?.currentSha ? {
          buildId: manifest.data.build.id,
          builder: manifest.data.build.builder,
          workflow: manifest.data.build.workflow,
          completedAt: manifest.data.build.completedAt,
          verificationDigest: manifest.data.verification.digest,
          verificationEvidenceRef: manifest.data.verification.evidenceRef,
          cezarApi: manifest.data.compatibility.cezarApi,
          requiredCapabilities: manifest.data.compatibility.requiredCapabilities,
        } : null,
      };
    }));
    return { state, channels, history };
  }

  async state() {
    const receipts = await this.receipts();
    const successful = receipts.filter((receipt) => SUCCESS_RECEIPT_STATES.has(receipt.state));
    const lastSuccessful = successful.at(-1);
    const lastReceipt = receipts.at(-1);
    const configuredSha = this.context.configuredChannel ? (await this.pointer(this.context.configuredChannel))?.currentSha : undefined;
    const effectiveSha = this.context.effectiveSha;
    const shadowDiff = configuredSha && configuredSha !== effectiveSha
      ? { expectedSha: configuredSha, ...(effectiveSha ? { observedSha: effectiveSha } : {}) }
      : null;
    const findings: string[] = [];
    if (!this.context.configuredChannel) findings.push('unconfigured');
    if (shadowDiff) findings.push('shadow_drift');
    if (this.context.compatibility === 'incompatible') findings.push('incompatible');
    if (lastReceipt && (lastReceipt.state === 'failed' || lastReceipt.state === 'rolled_back')) findings.push('failed');
    const remediation: Record<string, string> = {
      unconfigured: 'Choose a release channel after confirming the release store is configured.',
      shadow_drift: 'Compare the observed SHA with the channel pointer, then use the release controller repair preview.',
      incompatible: 'Use a Cezar build compatible with the selected Factory release, or keep the previous channel.',
      failed: 'Inspect the latest activation receipt and repair its cause before retrying.',
    };
    const pinnedSha = (task: ProjectChannelTask) => task.sourceSha;
    return {
      schemaVersion: 'factory-project-channel-state/v1',
      projectId: this.context.projectId,
      configuredChannel: this.context.configuredChannel ?? null,
      configuredSha: configuredSha ?? null,
      effectiveSha: effectiveSha ?? null,
      lastSuccessfulActivation: lastSuccessful ? {
        sha: lastSuccessful.desiredSha,
        channel: lastSuccessful.channel,
        at: lastSuccessful.activatedAt ?? lastSuccessful.observedAt ?? null,
      } : null,
      deployed: Boolean(lastSuccessful && effectiveSha && lastSuccessful.desiredSha === effectiveSha),
      compatibility: this.context.compatibility,
      activeTasks: this.context.activeTasks.filter((task) => ACTIVE_TASK_STATES.has(task.status)).map((task) => ({ ...task, ...(pinnedSha(task) ? { sourceSha: pinnedSha(task) } : {}) })),
      installedPrecedence: {
        workflows: 'project workflows override the pinned Factory release workflows',
        skills: 'project and user skills precede the pinned Factory release skills',
        source: 'Cezar resolver and local skill/workflow loaders',
      },
      shadowDiff,
      lastReconcile: null,
      findings,
      remediation: findings.map((finding) => ({ finding, action: remediation[finding]! })),
      lastReceipt: lastReceipt ? { state: lastReceipt.state, sha: lastReceipt.desiredSha, reasonCode: lastReceipt.reasonCode, message: lastReceipt.message } : null,
      stale: false,
      readAt: this.now(),
    };
  }

  async preview(channel: FactoryChannel, target: ChannelTarget) {
    const state = await this.state();
    const pointer = await this.pointer(channel);
    if (!this.context.storeRoot || !pointer) return { allowed: false as const, reason: 'channel-unavailable', projectId: this.context.projectId, channel };
    if (await jsonFile(join(this.context.storeRoot, 'quarantine', `${pointer.currentSha}.json`))) {
      return { allowed: false as const, reason: 'target-release-quarantined', projectId: this.context.projectId, channel, sha: pointer.currentSha };
    }
    const diff = await overrideDiff(this.context.projectRoot, target.runtimeRoot);
    const warnings: string[] = [];
    if (state.activeTasks.length) warnings.push(`${state.activeTasks.length} active task(s) stay pinned to their saved Factory version; only new tasks use ${channel}.`);
    if (diff.some((item) => item.status === 'conflict')) warnings.push('Modified installed Factory files conflict with files in the target release.');
    const tokenData = {
      projectId: this.context.projectId,
      fromChannel: state.configuredChannel,
      toChannel: channel,
      targetSha: target.sourceSha,
      overrideDiff: diff,
      tasks: state.activeTasks.map((task) => task.id),
    };
    const token = sha256(canonicalizeFactoryJson(tokenData));
    return {
      allowed: true as const,
      readOnly: true as const,
      ...tokenData,
      activeTasks: state.activeTasks,
      pinnedTasksUnaffected: true as const,
      noChange: state.configuredChannel === channel,
      overrideDiff: diff,
      warnings,
      token,
    };
  }

  async recordRequest(channel: FactoryChannel, token: string, target: ChannelTarget, actor: string) {
    if (!this.context.storeRoot) return { status: 'refused' as const, reason: 'release-store-not-configured' };
    const auditDir = join(this.context.storeRoot, 'channel-change-audit');
    const existingPath = join(auditDir, `${token}.json`);
    const existing = await jsonFile(existingPath) as Record<string, unknown> | undefined;
    if (existing) return { status: 'requested' as const, audit: basename(existingPath), ...existing, duplicate: true };
    const preview = await this.preview(channel, target);
    if (!preview.allowed) return { status: 'refused' as const, ...preview };
    if (preview.noChange) return { status: 'refused' as const, reason: 'already-on-channel', projectId: this.context.projectId };
    if (preview.token !== token) return { status: 'refused' as const, reason: 'stale-preview', currentToken: preview.token };
    const entry = {
      schemaVersion: 'factory-channel-change-request/v1',
      requestedAt: this.now(),
      actor,
      projectId: this.context.projectId,
      fromChannel: preview.fromChannel,
      toChannel: channel,
      targetSha: target.sourceSha,
      previewToken: token,
      state: 'requested',
      applies: 'Cezar project configuration now selects the channel; running tasks retain their saved release pin.',
    };
    const path = join(auditDir, `${token}.json`);
    try {
      await mkdir(auditDir, { recursive: true });
      await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return { status: 'requested' as const, audit: basename(path), ...entry };
  }
}
